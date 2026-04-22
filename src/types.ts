/**
 * src/types.ts
 * Shared types for the shogun API testing engine.
 */

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export type EnvVars = Record<string, string>;

// ---------------------------------------------------------------------------
// Test Definition (parsed from YAML)
// ---------------------------------------------------------------------------

export interface RequestBody {
  /** Inline JSON body — supports ${VAR} interpolation */
  inline?: Record<string, unknown>;
  /** Path to a JSON fixture file (relative to the YAML file location) */
  file?: string;
}

export interface RequestDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** URL path, may contain ${VAR} tokens */
  path: string;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  body?: RequestBody;
}

export interface ResponseDef {
  /** Expected HTTP status code */
  status?: number;
  /** Enable snapshot baseline diff */
  snapshot?: boolean;
  /** jq paths to strip before snapshot diff (merged with global config) */
  ignore_fields?: string[];
  /** Array of jq boolean expressions — each must evaluate truthy */
  shape?: string[];
}

export interface TestDefinition {
  name: string;
  description?: string;
  collection?: string;
  tags?: string[];
  /**
   * Ordered list of test IDs this test depends on.
   * Format: "collection/test-name" (cross-collection) or "test-name" (same collection).
   * The runner will execute all deps — and their collection setups — before this test.
   * Each dep runs at most once per session regardless of how many tests reference it.
   */
  dependsOn?: string[];
  /** Per-test env var overrides (merged on top of loaded .env) */
  env?: EnvVars;
  /** TypeScript source — runs before curl. May mutate ctx.request. */
  pre?: string;
  request: RequestDef;
  response?: ResponseDef;
  /** TypeScript source — runs after assertions. Has ctx.response. */
  post?: string;
}

// ---------------------------------------------------------------------------
// Collection Definition (parsed from _collection.yaml)
// ---------------------------------------------------------------------------

export interface CollectionDefinition {
  name: string;
  description?: string;
  order?: string[];
  tags?: string[];
  /**
   * Named setup fixtures to run before this collection's own setup: script.
   * References fixture names in tests/setup-fixtures/ (without .yaml extension).
   * Fixtures are idempotent — each runs at most once per session.
   */
  setup_fixtures?: string[];
  /** TypeScript source — runs once before first test (after setup_fixtures) */
  setup?: string;
  /** TypeScript source — runs once after last test, even on failure */
  teardown?: string;
  /**
   * Pre-seeded into ctx.vars before setup_fixtures and setup run.
   * Collection vars override suite vars on collision.
   * Values declared here belong to the collection, not the .env file.
   */
  vars?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Suite Definition (parsed from tests/suites/*.yaml)
// ---------------------------------------------------------------------------

export interface SuiteDefinition {
  name: string;
  description?: string;
  collections: string[];
  tags?: string[];
  /**
   * Pre-seeded into ctx.vars at run start, before any collection setup fires.
   * Suite vars are overridden by collection vars on collision.
   * Use for suite-level parameters like WORKSPACE_NAME that differ per suite.
   */
  vars?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Setup Fixture Definition (parsed from tests/setup-fixtures/*.yaml)
// ---------------------------------------------------------------------------

/**
 * A named, reusable setup script that can be referenced by multiple collections
 * via setup_fixtures: [...]. Fixtures are stateless setup-only scripts — no teardown.
 * They should be idempotent (guard with ctx.vars._fixtureLoaded_{name}).
 */
export interface SetupFixtureDefinition {
  name: string;
  description?: string;
  /** TypeScript source — same ctx as collection setup, including ctx.http */
  script: string;
}

// ---------------------------------------------------------------------------
// Runtime context — injected into pre/post scripts
// ---------------------------------------------------------------------------

export interface ShogunRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  body?: unknown;
}

export interface ShogunResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
  duration: number;
  /** Time reported by curl's own %{time_total} (ms) */
  curlMs: number;
}

export type HttpMethod = {
  get(path: string, opts?: RequestOpts): Promise<ShogunResponse>;
  post(path: string, body: unknown, opts?: RequestOpts): Promise<ShogunResponse>;
  put(path: string, body: unknown, opts?: RequestOpts): Promise<ShogunResponse>;
  patch(path: string, body: unknown, opts?: RequestOpts): Promise<ShogunResponse>;
  delete(path: string, opts?: RequestOpts): Promise<ShogunResponse>;
};

export interface RequestOpts {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  timeout?: number;
}

export interface ShogunContext {
  /** Merged env vars: global config + .env file + test-level overrides */
  env: EnvVars;
  /** Mutable cross-test variable store — persists for the entire run */
  vars: Record<string, unknown>;
  /** Current request — mutable in pre-script */
  request: ShogunRequest;
  /** Current response — available in post-script */
  response: ShogunResponse;
  /** Throws ShogunAssertionError if condition is false */
  assert(condition: boolean, message: string): void;
  /** Write a message to stdout and to the per-test run log */
  log(message: string): void;
  /** HTTP helpers for setup/teardown/chaining (does NOT use curl) */
  http: HttpMethod;
  /** Shared scripts loaded from scripts/ directory */
  scripts: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Assertion results
// ---------------------------------------------------------------------------

export interface ShapeAssertionResult {
  expr: string;
  passed: boolean;
  error?: string;
}

export interface AssertionResults {
  status?: boolean;
  shape?: ShapeAssertionResult[];
  snapshot?: boolean;
  snapshotDiff?: string | null;
  postScript?: boolean;
  postScriptError?: string;
}

// ---------------------------------------------------------------------------
// Run log schema
// ---------------------------------------------------------------------------

export type TestResultStatus = 'passed' | 'failed' | 'needs_baseline' | 'dependency_failed';

export interface TestTimings {
  /** Wall-clock time for curl to complete, per curl's own %{time_total} */
  curlMs: number;
  /** Time spent in jq shape checks + snapshot diff */
  assertMs: number;
  /** Time spent running the pre-script (tsx transpile + execute) */
  preMs: number;
  /** Time spent running the post-script (tsx transpile + execute) */
  postMs: number;
  /** Remainder: request build, env merge, bookkeeping */
  otherMs: number;
}

export interface TestResult {
  name: string;
  file: string;
  status: TestResultStatus;
  httpStatus?: number;
  durationMs: number;
  timings?: TestTimings;
  assertions: AssertionResults;
  scriptOutput?: string[];
  error?: string;
  /**
   * When status === 'dependency_failed': the canonical ID ("collection/test-name")
   * of the first dependency that failed. Enables root-cause tracing without noise.
   */
  failedDependency?: string;
  /**
   * The resolved request that was (or would have been) sent to the server.
   * Only populated on failed tests — omitted on passing tests to reduce noise.
   */
  resolvedRequest?: ShogunRequest;
  /**
   * The raw HTTP response received from the server.
   * Only populated on failed tests — omitted on passing tests to reduce noise.
   */
  resolvedResponse?: ShogunResponse;
}

export interface RunSummary {
  runId: string;
  env: string;
  collection?: string;
  suite?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  needsBaseline: number;
  dependencyFailed: number;
  results: TestResult[];
}

// ---------------------------------------------------------------------------
// Session state — tracks what has executed within a single shogun run
// ---------------------------------------------------------------------------

/**
 * Maintained for the lifetime of a single `shogun run` invocation.
 * Ensures deps and fixtures execute at most once per session.
 */
export interface SessionState {
  /**
   * Canonical test IDs ("collection/test-name") → execution outcome.
   * Tests not yet attempted are absent from the map.
   */
  testsRun: Map<string, 'passed' | 'failed'>;
  /**
   * Collection names whose setup hook (including setup_fixtures) has already run.
   */
  collectionsSetup: Set<string>;
  /**
   * Collection names whose teardown hook has already run.
   */
  collectionsTornDown: Set<string>;
  /**
   * Fixture names already executed this session (idempotency enforcement layer).
   */
  fixturesRun: Set<string>;
}

// ---------------------------------------------------------------------------
// Config file schema (shogun.config.yaml)
// ---------------------------------------------------------------------------

export interface ShogunConfig {
  version: number;
  defaults?: {
    env?: string;
    timeout?: number;
    follow_redirects?: boolean;
    content_type?: string;
  };
  paths?: {
    tests?: string;
    envs?: string;
    expected?: string;
    runs?: string;
    scripts?: string;
    /** Directory containing setup fixture YAML files. Default: tests/setup-fixtures */
    setup_fixtures?: string;
  };
  ignore_fields_global?: string[];
  reporting?: {
    format?: 'pretty' | 'json' | 'tap';
    on_fail?: 'diff' | 'body' | 'silent';
    save_passing_logs?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ShogunAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShogunAssertionError';
  }
}

export class ShogunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShogunConfigError';
  }
}
