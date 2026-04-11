/**
 * src/types.ts
 * Shared types for the shotgun API testing engine.
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
  /** TypeScript source — runs once before first test */
  setup?: string;
  /** TypeScript source — runs once after last test, even on failure */
  teardown?: string;
}

// ---------------------------------------------------------------------------
// Runtime context — injected into pre/post scripts
// ---------------------------------------------------------------------------

export interface ShotgunRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  body?: unknown;
}

export interface ShotgunResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
  duration: number;
  /** Time reported by curl's own %{time_total} (ms) */
  curlMs: number;
}

export type HttpMethod = {
  get(path: string, opts?: RequestOpts): Promise<ShotgunResponse>;
  post(path: string, body: unknown, opts?: RequestOpts): Promise<ShotgunResponse>;
  put(path: string, body: unknown, opts?: RequestOpts): Promise<ShotgunResponse>;
  patch(path: string, body: unknown, opts?: RequestOpts): Promise<ShotgunResponse>;
  delete(path: string, opts?: RequestOpts): Promise<ShotgunResponse>;
};

export interface RequestOpts {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  timeout?: number;
}

export interface ShotgunContext {
  /** Merged env vars: global config + .env file + test-level overrides */
  env: EnvVars;
  /** Mutable cross-test variable store — persists for the entire run */
  vars: Record<string, unknown>;
  /** Current request — mutable in pre-script */
  request: ShotgunRequest;
  /** Current response — available in post-script */
  response: ShotgunResponse;
  /** Throws ShotgunAssertionError if condition is false */
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

export type TestResultStatus = 'passed' | 'failed' | 'needs_baseline';

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
  results: TestResult[];
}

// ---------------------------------------------------------------------------
// Config file schema (shotgun.config.yaml)
// ---------------------------------------------------------------------------

export interface ShotgunConfig {
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

export class ShotgunAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShotgunAssertionError';
  }
}

export class ShotgunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShotgunConfigError';
  }
}
