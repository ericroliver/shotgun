/**
 * src/runner.ts
 * Main test execution loop.
 * Orchestrates: load → pre-script → curl → assert → post-script → log
 */

import { join, relative } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { loadConfig, loadEnv, loadTestFile, loadCollection, discoverCollections, loadSuite } from './loader.js';
import { executeRequest, checkDependencies } from './executor.js';
import { runAssertions, assertionsAllPassed, writeSnapshot } from './asserter.js';
import { runScript } from './scripter.js';
import { RunLogger } from './logger.js';
import { printCollectionHeader, printTestStart, printTestResult, printSummary } from './reporter.js';
import type { ShotgunRequest, ShotgunResponse, TestResult, TestTimings, EnvVars, RunSummary, ShotgunConfig } from './types.js';

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
    // Apply suite-level tags as the active tag filter when no explicit --tags flag was given.
    // This ensures a suite like smoke (tags: [smoke]) only runs tests carrying that tag.
    if (!opts.tags?.length && suite.tags?.length) {
      opts.tags = suite.tags;
    }
  } else if (opts.collection) {
    collectionNames = [opts.collection];
  } else {
    collectionNames = discoverCollections(config, cwd);
  }

  // Run each collection
  for (const collectionName of collectionNames) {
    const { definition, testFiles } = loadCollection(collectionName, config, cwd);

    // Tag filter at collection level.
    // When running a suite, skip this check — the suite already enumerates its collections
    // explicitly, and its tags: field is a test-level filter, not a collection filter.
    // When running with --tags from the CLI (no suite), skip entire collections that have
    // no overlapping tags with the requested tags.
    if (!opts.suite && opts.tags?.length && !opts.tags.some(t => definition.tags?.includes(t))) {
      continue;
    }

    printCollectionHeader(definition.name ?? collectionName);

    // Merge collection-level env overrides (none in this design, but vars is shared)
    // Run collection setup hook
    if (definition.setup) {
      let setupError: string | null = null;
      try {
        const dummyRequest = makeDummyRequest(baseUrl);
        const result = await runScript(definition.setup, {
          env, vars, request: dummyRequest, scriptsDir,
        });
        applyVarMutations(vars, result.varMutations);
        if (!result.passed) {
          setupError = result.error ?? 'collection setup failed';
        }
      } catch (err) {
        setupError = String(err);
      }

      if (setupError !== null) {
        console.error(`Collection setup failed: ${setupError}`);
        // Fail all tests in collection
        for (const file of testFiles) {
          const test = loadTestFile(file, env);
          const failed: TestResult = {
            name: test.name,
            file,
            status: 'failed',
            durationMs: 0,
            assertions: {},
            error: `Collection setup failed: ${setupError}`,
          };
          logger.recordTest(failed, collectionName);
          printTestStart(test.name, test.request.method, test.request.path);
          printTestResult(failed);
        }
        continue;
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

  // Auto-update the _failures_ collection whenever any test failed
  if (summary.failed > 0) {
    updateFailuresCollection(summary.results, config, cwd);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Single test execution
// ---------------------------------------------------------------------------

interface SingleTestOpts {
  env: EnvVars;
  vars: Record<string, unknown>;
  baseUrl: string;
  config: ShotgunConfig;
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
  let request: ShotgunRequest = {
    method: test.request.method,
    path: test.request.path,
    url: buildUrl(opts.baseUrl, test.request.path),
    headers: (test.request as { headers?: Record<string, string> }).headers ?? {},
    params: normalizeParams((test.request as { params?: Record<string, string | number | boolean> }).params ?? {}),
    body: (test.request as { body?: unknown }).body,
  };

  // Pre-script
  let preMs = 0;
  if (test.pre) {
    const preStart = Date.now();
    try {
      const preResult = await runScript(test.pre, {
        env: opts.env,
        vars: opts.vars,
        request,
        scriptsDir: opts.scriptsDir,
      });
      preMs = Date.now() - preStart;
      scriptOutput.push(...preResult.logs);
      if (!preResult.passed) {
        return makeFailedResult(test.name, file, startMs, {}, `Pre-script failed: ${preResult.error}`, scriptOutput);
      }
      // Apply request mutations from pre-script
      if (preResult.requestMutations) {
        request = mergeRequest(request, preResult.requestMutations, opts.baseUrl);
      }
      // Apply var mutations
      applyVarMutations(opts.vars, preResult.varMutations);
    } catch (err) {
      preMs = Date.now() - preStart;
      return makeFailedResult(test.name, file, startMs, {}, `Pre-script threw: ${err}`, scriptOutput);
    }
  }

  // Execute HTTP request
  let response: ShotgunResponse;
  try {
    response = await executeRequest(request, opts.env, {
      timeout: parseInt(opts.env.TIMEOUT ?? '10', 10),
    });
  } catch (err) {
    return makeFailedResult(test.name, file, startMs, {}, `curl failed: ${err}`, scriptOutput);
  }

  // Assertions
  const assertStart = Date.now();
  const fullTest = test as Parameters<typeof runAssertions>[0]['test'];
  const assertions = await runAssertions({
    test: fullTest,
    response,
    config: opts.config,
    cwd: opts.cwd,
    collectionName: opts.collectionName,
    snapshotMode: opts.snapshotMode,
  });
  const assertMs = Date.now() - assertStart;

  // Check for missing baseline
  const needsBaseline = test.response &&
    (test.response as { snapshot?: boolean }).snapshot &&
    assertions.snapshot === false &&
    !assertions.snapshotDiff;

  // Post-script
  let postMs = 0;
  if (test.post) {
    const postStart = Date.now();
    try {
      const postResult = await runScript(test.post, {
        env: opts.env,
        vars: opts.vars,
        request,
        response,
        scriptsDir: opts.scriptsDir,
      });
      postMs = Date.now() - postStart;
      scriptOutput.push(...postResult.logs);
      applyVarMutations(opts.vars, postResult.varMutations);
      assertions.postScript = postResult.passed;
      if (!postResult.passed) {
        assertions.postScriptError = postResult.error;
      }
    } catch (err) {
      postMs = Date.now() - postStart;
      assertions.postScript = false;
      assertions.postScriptError = String(err);
    }
  }

  const durationMs = Date.now() - startMs;
  const curlMs = response.curlMs;
  const allPassed = assertionsAllPassed(assertions);

  const timings: TestTimings = {
    curlMs,
    assertMs,
    preMs,
    postMs,
    otherMs: Math.max(0, durationMs - curlMs - assertMs - preMs - postMs),
  };

  return {
    name: test.name,
    file,
    status: needsBaseline ? 'needs_baseline' : allPassed ? 'passed' : 'failed',
    httpStatus: response.status,
    durationMs,
    timings,
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
// Failures collection updater
// ---------------------------------------------------------------------------

/**
 * Rewrites local-dev-test-repo/tests/collections/_failures_/_collection.yaml
 * (or the equivalent path under `cwd`) so that its `order` list contains only
 * the cross-collection references for tests that failed in this run.
 *
 * The file is only written when there are failures; a clean run leaves it
 * unchanged so the previous failure list is preserved for reference.
 */
function updateFailuresCollection(
  results: import('./types.js').TestResult[],
  config: import('./types.js').ShotgunConfig,
  cwd: string,
): void {
  const testsDir = join(cwd, config.paths?.tests ?? 'tests');
  const collectionsDir = join(testsDir, 'collections');
  const failuresDir = join(collectionsDir, '_failures_');

  const failedRefs = results
    .filter(r => r.status === 'failed')
    .map(r => {
      // r.file is an absolute path like: …/collections/some-coll/test-name.yaml
      // We want: "some-coll/test-name"
      const rel = relative(collectionsDir, r.file);          // "some-coll/test-name.yaml"
      return rel.replace(/\.yaml$/, '');                     // "some-coll/test-name"
    })
    // Deduplicate (shouldn't happen, but be safe)
    .filter((ref, i, arr) => arr.indexOf(ref) === i);

  if (failedRefs.length === 0) return;

  const orderLines = failedRefs.map(ref => `  - ${ref}`).join('\n');
  const timestamp = new Date().toISOString();

  const yaml = `# _failures_/_collection.yaml
#
# Auto-managed by the banger runner.
#
# After any run that contains failures, banger rewrites the \`order\` list below
# with the collection/test references of every test that failed.  Re-running
# this collection with:
#
#   banger run --collection _failures_
#
# lets you quickly re-execute only the tests that broke in the previous run
# without having to remember which ones they were.
#
# The setup/teardown scripts are intentionally empty — each referenced test
# brings its own collection's setup via the cross-collection reference
# mechanism.  Do not add shared auth or workspace-load logic here; it belongs
# in the originating collection.
#
# ⚠️  Do not hand-edit the \`order\` list — it is overwritten on every run that
#     produces failures.  To permanently pin a subset of tests, copy the list
#     into a new named collection or suite instead.
#
# Last updated: ${timestamp}

name: Failures
description: >
  Automatically populated with the tests that failed in the most recent run.
  Re-run with \`banger run --collection _failures_\` to replay only failures.

order:
${orderLines}

tags:
  - failures
  - auto

setup: |
  ctx.log('_failures_ collection — no shared setup; each test owns its own context.');

teardown: |
  ctx.log('_failures_ collection teardown complete.');
`;

  if (!existsSync(failuresDir)) {
    mkdirSync(failuresDir, { recursive: true });
  }

  const outPath = join(failuresDir, '_collection.yaml');
  writeFileSync(outPath, yaml, 'utf8');
  console.log(`\n  ✎  _failures_ collection updated (${failedRefs.length} test${failedRefs.length === 1 ? '' : 's'}): ${outPath}`);
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

function mergeRequest(base: ShotgunRequest, mutations: Partial<ShotgunRequest>, baseUrl: string): ShotgunRequest {
  const merged = { ...base, ...mutations };
  // Re-derive URL if path changed
  if (mutations.path && mutations.path !== base.path) {
    merged.url = buildUrl(baseUrl, mutations.path);
  }
  return merged;
}

function applyVarMutations(vars: Record<string, unknown>, varMutations?: Record<string, unknown>): void {
  if (!varMutations) return;
  for (const [key, value] of Object.entries(varMutations)) {
    vars[key] = value;
  }
}

function makeDummyRequest(baseUrl: string): ShotgunRequest {
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
