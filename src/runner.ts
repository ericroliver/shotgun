/**
 * src/runner.ts
 * Main test execution loop.
 * Orchestrates: load → pre-script → curl → assert → post-script → log
 */

import { join } from 'node:path';
import { loadConfig, loadEnv, loadTestFile, loadCollection, discoverCollections, loadSuite } from './loader.js';
import { executeRequest, checkDependencies } from './executor.js';
import { runAssertions, assertionsAllPassed, writeSnapshot } from './asserter.js';
import { runScript } from './scripter.js';
import { RunLogger } from './logger.js';
import { printCollectionHeader, printTestStart, printTestResult, printSummary } from './reporter.js';
import type { BangerRequest, BangerResponse, TestResult, EnvVars, RunSummary, BangerConfig } from './types.js';

export interface RunOptions {
  env?: string;
  collection?: string;
  tags?: string[];
  suite?: string;
  file?: string;
  format?: 'pretty' | 'json' | 'tap';
  snapshotMode?: boolean;
  cwd?: string;
}

export async function runTests(opts: RunOptions): Promise<RunSummary> {
  const cwd = opts.cwd ?? process.cwd();
  const config = loadConfig(cwd);
  const envName = opts.env ?? config.defaults?.env ?? 'local';

  // Validate tools
  await checkDependencies();

  // Load environment
  const env = loadEnv(envName, config, cwd);
  const baseUrl = env.BASE_URL ?? process.env.BASE_URL ?? '';

  if (!baseUrl) {
    throw new Error(`BASE_URL is not set in ${envName}.env`);
  }

  const scriptsDir = join(cwd, config.paths?.scripts ?? 'scripts');
  const logger = new RunLogger(config, cwd);
  const startedAt = new Date().toISOString();

  // Shared vars across entire run
  const vars: Record<string, unknown> = {};

  // Determine which collections to run
  let collectionNames: string[] = [];

  if (opts.file) {
    // Single file mode — run outside collection context
    const result = await runSingleFile(opts.file, { env, vars, baseUrl, config, scriptsDir, cwd, snapshotMode: opts.snapshotMode });
    logger.recordTest(result, 'file');
    const summary = logger.finalize({ env: envName, startedAt });
    printSummary(summary);
    return summary;
  } else if (opts.suite) {
    const suite = loadSuite(opts.suite, config, cwd);
    collectionNames = suite.collections;
  } else if (opts.collection) {
    collectionNames = [opts.collection];
  } else {
    collectionNames = discoverCollections(config, cwd);
  }

  // Run each collection
  for (const collectionName of collectionNames) {
    const { definition, testFiles } = loadCollection(collectionName, config, cwd);

    // Tag filter at collection level
    if (opts.tags?.length && !opts.tags.some(t => definition.tags?.includes(t))) {
      // Collection has no overlapping tags — skip unless filtering at test level
    }

    printCollectionHeader(definition.name ?? collectionName);

    // Merge collection-level env overrides (none in this design, but vars is shared)
    // Run collection setup hook
    if (definition.setup) {
      try {
        const dummyRequest = makeDummyRequest(baseUrl);
        const result = await runScript(definition.setup, {
          env, vars, request: dummyRequest, scriptsDir,
        });
        applyVarMutations(vars, result.requestMutations);
        if (!result.passed) {
          console.error(`Collection setup failed: ${result.error}`);
          // Skip all tests in collection
          for (const file of testFiles) {
            const test = loadTestFile(file, env);
            const skipped: TestResult = {
              name: test.name,
              file,
              status: 'skipped',
              durationMs: 0,
              assertions: {},
              error: `Skipped — collection setup failed: ${result.error}`,
            };
            logger.recordTest(skipped, collectionName);
            printTestResult(skipped);
          }
          continue;
        }
      } catch (err) {
        console.error(`Collection setup threw: ${err}`);
      }
    }

    // Run each test
    for (const file of testFiles) {
      const test = loadTestFile(file, { ...env });

      // Tag filter at test level
      if (opts.tags?.length && !opts.tags.some(t => test.tags?.includes(t))) {
        continue;
      }

      printTestStart(test.name, test.request.method, test.request.path);

      const result = await runSingleTest(test, file, {
        env: { ...env, ...(test.env ?? {}) },
        vars,
        baseUrl,
        config,
        scriptsDir,
        cwd,
        collectionName,
        snapshotMode: opts.snapshotMode,
      });

      logger.recordTest(result, collectionName);
      printTestResult(result);
    }

    // Run collection teardown (even on failures)
    if (definition.teardown) {
      try {
        const dummyRequest = makeDummyRequest(baseUrl);
        const result = await runScript(definition.teardown, {
          env, vars, request: dummyRequest, scriptsDir,
        });
        if (!result.passed) {
          console.warn(`  ${c.yellow}Teardown warning: ${result.error}${c.reset}`);
        }
      } catch (err) {
        console.warn(`  Teardown threw (non-fatal): ${err}`);
      }
    }
  }

  const summary = logger.finalize({
    env: envName,
    collection: opts.collection,
    suite: opts.suite,
    startedAt,
  });

  printSummary(summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Single test execution
// ---------------------------------------------------------------------------

interface SingleTestOpts {
  env: EnvVars;
  vars: Record<string, unknown>;
  baseUrl: string;
  config: BangerConfig;
  scriptsDir: string;
  cwd: string;
  collectionName?: string;
  snapshotMode?: boolean;
}

async function runSingleTest(
  test: { name: string; request: { method: string; path: string }; pre?: string; post?: string; response?: unknown; tags?: string[]; collection?: string; env?: EnvVars; description?: string },
  file: string,
  opts: SingleTestOpts,
): Promise<TestResult> {
  const scriptOutput: string[] = [];
  const startMs = Date.now();

  // Build initial request
  let request: BangerRequest = {
    method: test.request.method,
    path: test.request.path,
    url: buildUrl(opts.baseUrl, test.request.path),
    headers: (test.request as { headers?: Record<string, string> }).headers ?? {},
    params: normalizeParams((test.request as { params?: Record<string, string | number | boolean> }).params ?? {}),
    body: (test.request as { body?: unknown }).body,
  };

  // Pre-script
  if (test.pre) {
    try {
      const preResult = await runScript(test.pre, {
        env: opts.env,
        vars: opts.vars,
        request,
        scriptsDir: opts.scriptsDir,
      });
      scriptOutput.push(...preResult.logs);
      if (!preResult.passed) {
        return makeFailedResult(test.name, file, startMs, {}, `Pre-script failed: ${preResult.error}`, scriptOutput);
      }
      // Apply request mutations from pre-script
      if (preResult.requestMutations) {
        request = mergeRequest(request, preResult.requestMutations, opts.baseUrl);
      }
      // Apply var mutations
      applyVarMutations(opts.vars, preResult.requestMutations);
    } catch (err) {
      return makeFailedResult(test.name, file, startMs, {}, `Pre-script threw: ${err}`, scriptOutput);
    }
  }

  // Execute HTTP request
  let response: BangerResponse;
  try {
    response = await executeRequest(request, opts.env, {
      timeout: parseInt(opts.env.TIMEOUT ?? '10', 10),
    });
  } catch (err) {
    return makeFailedResult(test.name, file, startMs, {}, `curl failed: ${err}`, scriptOutput);
  }

  // Assertions
  const fullTest = test as Parameters<typeof runAssertions>[0]['test'];
  const assertions = await runAssertions({
    test: fullTest,
    response,
    config: opts.config,
    cwd: opts.cwd,
    collectionName: opts.collectionName,
    snapshotMode: opts.snapshotMode,
  });

  // Check for missing baseline
  const needsBaseline = test.response &&
    (test.response as { snapshot?: boolean }).snapshot &&
    assertions.snapshot === false &&
    !assertions.snapshotDiff;

  // Post-script
  if (test.post) {
    try {
      const postResult = await runScript(test.post, {
        env: opts.env,
        vars: opts.vars,
        request,
        response,
        scriptsDir: opts.scriptsDir,
      });
      scriptOutput.push(...postResult.logs);
      applyVarMutations(opts.vars, postResult.requestMutations);
      assertions.postScript = postResult.passed;
      if (!postResult.passed) {
        assertions.postScriptError = postResult.error;
      }
    } catch (err) {
      assertions.postScript = false;
      assertions.postScriptError = String(err);
    }
  }

  const durationMs = Date.now() - startMs;
  const allPassed = assertionsAllPassed(assertions);

  return {
    name: test.name,
    file,
    status: needsBaseline ? 'needs_baseline' : allPassed ? 'passed' : 'failed',
    httpStatus: response.status,
    durationMs,
    assertions,
    scriptOutput: scriptOutput.length ? scriptOutput : undefined,
  };
}

async function runSingleFile(
  file: string,
  opts: SingleTestOpts,
): Promise<TestResult> {
  const test = loadTestFile(file, opts.env);
  return runSingleTest(test, file, opts);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUrl(baseUrl: string, path: string): string {
  if (path.startsWith('http')) return path;
  return baseUrl.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
}

function normalizeParams(params: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

function mergeRequest(base: BangerRequest, mutations: Partial<BangerRequest>, baseUrl: string): BangerRequest {
  const merged = { ...base, ...mutations };
  // Re-derive URL if path changed
  if (mutations.path && mutations.path !== base.path) {
    merged.url = buildUrl(baseUrl, mutations.path);
  }
  return merged;
}

function applyVarMutations(vars: Record<string, unknown>, mutations?: Partial<BangerRequest>): void {
  // vars are mutated directly by the script via ctx.vars reference
  // This is a no-op placeholder — the shared vars object is mutated in-place inside the script context
  void vars;
  void mutations;
}

function makeDummyRequest(baseUrl: string): BangerRequest {
  return {
    method: 'GET',
    path: '/',
    url: baseUrl,
    headers: {},
    params: {},
  };
}

function makeFailedResult(
  name: string,
  file: string,
  startMs: number,
  assertions: Record<string, unknown>,
  error: string,
  scriptOutput: string[],
): TestResult {
  return {
    name,
    file,
    status: 'failed',
    durationMs: Date.now() - startMs,
    assertions,
    error,
    scriptOutput: scriptOutput.length ? scriptOutput : undefined,
  };
}

// Color codes (same as reporter, inlined to avoid circular dep)
const isTTY = process.stdout.isTTY;
const c = {
  yellow: isTTY ? '\x1b[33m' : '',
  reset:  isTTY ? '\x1b[0m'  : '',
};
