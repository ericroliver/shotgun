/**
 * src/runner.ts
 * Main test execution loop.
 * Orchestrates: load → pre-script → curl → assert → post-script → log
 *
 * New in this version:
 *  - SessionState: deduplicates test execution and collection setup across a run
 *  - setup_fixtures: runs named shared setup scripts before each collection's own setup
 *  - dependsOn: automatically resolves and runs test dependencies before the target test
 */

import { join, relative } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import {
  loadConfig, loadEnv, loadTestFile, loadCollection, discoverCollections,
  loadSuite, loadSetupFixture, buildDependencyOrder, resolveTestRef,
} from './loader.js';
import { executeRequest, checkDependencies } from './executor.js';
import { runAssertions, assertionsAllPassed, writeSnapshot } from './asserter.js';
import { runScript } from './scripter.js';
import { RunLogger } from './logger.js';
import {
  printCollectionHeader, printTestStart, printTestResult, printSummary,
} from './reporter.js';
import type {
  ShotgunRequest, ShotgunResponse, TestResult, TestTimings, EnvVars,
  RunSummary, ShotgunConfig, SessionState, SuiteDefinition,
} from './types.js';

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
  const testsDir = join(cwd, config.paths?.tests ?? 'tests');
  const collectionsDir = join(testsDir, 'collections');
  const logger = new RunLogger(config, cwd);
  const startedAt = new Date().toISOString();

  // Shared vars across entire run
  const vars: Record<string, unknown> = {};

  // Session state — deduplicates test runs, collection setups, fixture executions
  const session: SessionState = {
    testsRun: new Map(),
    collectionsSetup: new Set(),
    collectionsTornDown: new Set(),
    fixturesRun: new Set(),
  };

  // Shared opts passed to helpers
  const sharedOpts: SharedRunOpts = {
    env, vars, baseUrl, config, scriptsDir, cwd, collectionsDir,
    snapshotMode: opts.snapshotMode, session, logger,
  };

  // -------------------------------------------------------------------------
  // Single file mode — run outside collection context
  // -------------------------------------------------------------------------

  if (opts.file) {
    const result = await runSingleFile(opts.file, sharedOpts);
    logger.recordTest(result, 'file');
    const summary = logger.finalize({ env: envName, startedAt });
    printSummary(summary);
    return summary;
  }

  // -------------------------------------------------------------------------
  // Determine collection plan
  // -------------------------------------------------------------------------

  let collectionNames: string[] = [];

  if (opts.suite) {
    const suite: SuiteDefinition = loadSuite(opts.suite, config, cwd);
    collectionNames = suite.collections;
    if (!opts.tags?.length && suite.tags?.length) {
      opts.tags = suite.tags;
    }
    // Merge suite-level vars into ctx.vars — lowest precedence layer
    if (suite.vars) {
      Object.assign(vars, suite.vars);
    }
  } else if (opts.collection) {
    collectionNames = [opts.collection];
  } else {
    collectionNames = discoverCollections(config, cwd);
  }

  // -------------------------------------------------------------------------
  // Run each collection
  // -------------------------------------------------------------------------

  for (const collectionName of collectionNames) {
    const { definition, testFiles } = loadCollection(collectionName, config, cwd);

    // Tag filter at collection level
    if (!opts.suite && opts.tags?.length && !opts.tags.some(t => definition.tags?.includes(t))) {
      continue;
    }

    printCollectionHeader(definition.name ?? collectionName);

    // Run collection setup (includes setup_fixtures), deduped by session
    const setupOk = await ensureCollectionSetup(collectionName, definition, sharedOpts);

    if (!setupOk) {
      // Fail all tests in this collection
      for (const file of testFiles) {
        const test = loadTestFile(file, env);
        const failed: TestResult = {
          name: test.name,
          file,
          status: 'failed',
          durationMs: 0,
          assertions: {},
          error: `Collection setup failed for "${collectionName}"`,
        };
        logger.recordTest(failed, collectionName);
        printTestStart(test.name, test.request.method, test.request.path);
        printTestResult(failed);
      }
      continue;
    }

    // Run each test
    for (const file of testFiles) {
      const test = loadTestFile(file, { ...env });

      // Tag filter at test level
      if (opts.tags?.length && !opts.tags.some(t => test.tags?.includes(t))) {
        continue;
      }

      printTestStart(test.name, test.request.method, test.request.path);

      // Resolve the canonical ID from the actual file path — handles cross-collection
      // refs stored in _failures_ / _debug_ collections where collectionName is the
      // container collection but the file lives under a different collection dir.
      const canonicalId = relative(collectionsDir, file).replace(/\.yaml$/, '');
      const actualCollection = canonicalId.includes('/')
        ? canonicalId.slice(0, canonicalId.indexOf('/'))
        : collectionName;

      // Run dependsOn chain first (session-deduped)
      const depResult = await resolveDependencies(
        canonicalId,
        actualCollection,
        sharedOpts,
      );

      let result: TestResult;

      if (depResult.failedDep) {
        // A dependency failed — mark this test as dependency_failed
        result = {
          name: test.name,
          file,
          status: 'dependency_failed',
          durationMs: 0,
          assertions: {},
          error: `Dependency "${depResult.failedDep}" failed`,
          failedDependency: depResult.failedDep,
        };
      } else {
        result = await runSingleTest(test, file, {
          ...sharedOpts,
          env: { ...env, ...(test.env ?? {}) },
          collectionName: actualCollection,
        });

        // Register in session
        session.testsRun.set(canonicalId, result.status === 'passed' ? 'passed' : 'failed');
      }

      logger.recordTest(result, collectionName);
      printTestResult(result);
    }

    // Run collection teardown (even on failures), deduped by session
    await ensureCollectionTeardown(collectionName, definition, sharedOpts);
  }

  const summary = logger.finalize({
    env: envName,
    collection: opts.collection,
    suite: opts.suite,
    startedAt,
  });

  printSummary(summary);

  // Auto-update the _failures_ collection whenever any test failed
  if (summary.failed > 0 || summary.dependencyFailed > 0) {
    updateFailuresCollection(summary.results, config, cwd);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Shared opts type (internal)
// ---------------------------------------------------------------------------

interface SharedRunOpts {
  env: EnvVars;
  vars: Record<string, unknown>;
  baseUrl: string;
  config: ShotgunConfig;
  scriptsDir: string;
  cwd: string;
  collectionsDir: string;
  snapshotMode?: boolean;
  session: SessionState;
  logger: RunLogger;
}

// ---------------------------------------------------------------------------
// Collection setup / teardown (session-deduped)
// ---------------------------------------------------------------------------

/**
 * Runs setup_fixtures then collection setup — at most once per session.
 * Returns true if setup succeeded (or was already done), false on failure.
 */
async function ensureCollectionSetup(
  collectionName: string,
  definition: { setup_fixtures?: string[]; setup?: string; name?: string; vars?: Record<string, string> },
  opts: SharedRunOpts,
): Promise<boolean> {
  if (opts.session.collectionsSetup.has(collectionName)) return true;

  const dummyRequest = makeDummyRequest(opts.baseUrl);

  // 0. Merge collection-level vars into ctx.vars — overrides suite vars
  if (definition.vars) {
    Object.assign(opts.vars, definition.vars);
  }

  // 1. Run setup_fixtures in order
  if (definition.setup_fixtures?.length) {
    for (const fixtureName of definition.setup_fixtures) {
      // Fixture-level idempotency
      if (opts.session.fixturesRun.has(fixtureName)) {
        console.log(`  ⊙ fixture "${fixtureName}" already run this session — skipping`);
        continue;
      }

      let fixture;
      try {
        fixture = loadSetupFixture(fixtureName, opts.config, opts.cwd);
      } catch (err) {
        console.error(`  ✗ Failed to load setup fixture "${fixtureName}": ${err}`);
        return false;
      }

      try {
        const result = await runScript(fixture.script, {
          env: opts.env,
          vars: opts.vars,
          request: dummyRequest,
          scriptsDir: opts.scriptsDir,
        });
        applyVarMutations(opts.vars, result.varMutations);
        if (!result.passed) {
          console.error(`  ✗ Setup fixture "${fixtureName}" failed: ${result.error}`);
          return false;
        }
        opts.session.fixturesRun.add(fixtureName);
        console.log(`  ✓ fixture "${fixtureName}" complete`);
      } catch (err) {
        console.error(`  ✗ Setup fixture "${fixtureName}" threw: ${err}`);
        return false;
      }
    }
  }

  // 2. Run collection's own setup script
  if (definition.setup) {
    try {
      const result = await runScript(definition.setup, {
        env: opts.env,
        vars: opts.vars,
        request: dummyRequest,
        scriptsDir: opts.scriptsDir,
      });
      applyVarMutations(opts.vars, result.varMutations);
      if (!result.passed) {
        console.error(`Collection setup failed: ${result.error}`);
        return false;
      }
    } catch (err) {
      console.error(`Collection setup threw: ${err}`);
      return false;
    }
  }

  opts.session.collectionsSetup.add(collectionName);
  return true;
}

async function ensureCollectionTeardown(
  collectionName: string,
  definition: { teardown?: string },
  opts: SharedRunOpts,
): Promise<void> {
  if (opts.session.collectionsTornDown.has(collectionName)) return;
  if (!definition.teardown) {
    opts.session.collectionsTornDown.add(collectionName);
    return;
  }

  try {
    const dummyRequest = makeDummyRequest(opts.baseUrl);
    const result = await runScript(definition.teardown, {
      env: opts.env,
      vars: opts.vars,
      request: dummyRequest,
      scriptsDir: opts.scriptsDir,
    });
    if (!result.passed) {
      console.warn(`  ${c.yellow}Teardown warning (${collectionName}): ${result.error}${c.reset}`);
    }
  } catch (err) {
    console.warn(`  Teardown threw (non-fatal, ${collectionName}): ${err}`);
  }

  opts.session.collectionsTornDown.add(collectionName);
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

/**
 * Resolves and executes the full dependsOn chain for a test.
 * Returns { failedDep } if any dep failed, or { failedDep: null } if all passed.
 *
 * Each dep runs at most once per session (session.testsRun deduplication).
 * If a dep is in a different collection, that collection's setup runs first.
 */
async function resolveDependencies(
  targetCanonicalId: string,
  ownerCollection: string,
  opts: SharedRunOpts,
): Promise<{ failedDep: string | null }> {
  let depOrder: string[];
  try {
    depOrder = buildDependencyOrder(targetCanonicalId, opts.collectionsDir, opts.env);
  } catch (err) {
    // Cycle or missing dep — surface as failure
    return { failedDep: `[dependency resolution error] ${err}` };
  }

  if (depOrder.length === 0) return { failedDep: null };

  for (const depId of depOrder) {
    // Already ran this session?
    const priorOutcome = opts.session.testsRun.get(depId);
    if (priorOutcome === 'passed') continue;
    if (priorOutcome === 'failed') {
      return { failedDep: depId };
    }

    // Need to run it — ensure its collection setup is done first
    const depCollection = depId.slice(0, depId.indexOf('/'));
    const depTestName = depId.slice(depId.indexOf('/') + 1);
    const depFile = join(opts.collectionsDir, depCollection, `${depTestName}.yaml`);

    if (depCollection !== ownerCollection) {
      // Load and setup the dep's collection
      let depDefinition;
      try {
        const loaded = loadCollection(depCollection, opts.config, opts.cwd);
        depDefinition = loaded.definition;
      } catch (err) {
        opts.session.testsRun.set(depId, 'failed');
        return { failedDep: depId };
      }

      const setupOk = await ensureCollectionSetup(depCollection, depDefinition, opts);
      if (!setupOk) {
        opts.session.testsRun.set(depId, 'failed');
        return { failedDep: depId };
      }
    }

    // Execute the dependency test
    const depTest = loadTestFile(depFile, opts.env);
    printTestStart(depTest.name, depTest.request.method, depTest.request.path);

    const depResult = await runSingleTest(depTest, depFile, {
      ...opts,
      env: { ...opts.env, ...(depTest.env ?? {}) },
      collectionName: depCollection,
    });

    opts.logger.recordTest(depResult, depCollection);
    printTestResult(depResult);

    const outcome = depResult.status === 'passed' ? 'passed' : 'failed';
    opts.session.testsRun.set(depId, outcome);

    if (outcome === 'failed') {
      return { failedDep: depId };
    }
  }

  return { failedDep: null };
}

// ---------------------------------------------------------------------------
// Single test execution
// ---------------------------------------------------------------------------

interface SingleTestOpts extends SharedRunOpts {
  collectionName?: string;
}

async function runSingleTest(
  test: {
    name: string;
    request: { method: string; path: string };
    pre?: string;
    post?: string;
    response?: unknown;
    tags?: string[];
    collection?: string;
    env?: EnvVars;
    description?: string;
  },
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
  const finalStatus = needsBaseline ? 'needs_baseline' : allPassed ? 'passed' : 'failed';

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
    status: finalStatus,
    httpStatus: response.status,
    durationMs,
    timings,
    assertions,
    scriptOutput: scriptOutput.length ? scriptOutput : undefined,
    // Attach full request + response on failures so the reporter can dump diagnostics
    ...(finalStatus === 'failed' ? { resolvedRequest: request, resolvedResponse: response } : {}),
  };
}

async function runSingleFile(
  file: string,
  opts: SharedRunOpts,
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
    .filter(r => r.status === 'failed' || r.status === 'dependency_failed')
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
# Auto-managed by the shotgun runner.
#
# After any run that contains failures, shotgun rewrites the \`order\` list below
# with the collection/test references of every test that failed.  Re-running
# this collection with:
#
#   shotgun run --collection _failures_
#
# lets you quickly re-execute only the tests that broke in the previous run
# without having to remember which ones they were.
#
# Tests with \`dependsOn\` declared will have their dependencies automatically
# satisfied when re-run — even from this failures collection.
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
  Re-run with \`shotgun run --collection _failures_\` to replay only failures.

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
