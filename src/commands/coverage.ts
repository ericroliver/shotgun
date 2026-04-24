/**
 * src/commands/coverage.ts
 * `shogun coverage` — API test coverage matrix.
 *
 * Cross-references the OpenAPI spec against every test YAML in the configured
 * collections directory and emits a coverage report. No HTTP calls to the API
 * under test — this is purely static file I/O + spec fetch.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import {
  loadConfig,
  loadEnv,
  fetchSpec,
  discoverCollections,
  loadSuite,
} from '../loader.js';
import type { ShogunConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Public args interface
// ---------------------------------------------------------------------------

export interface CoverageArgs {
  /** Positional: override spec source (URL or local file path) */
  specSource?: string;
  /** --env: load env file for live spec fetching */
  env?: string;
  /** --collection: scope test-side to one collection */
  collection?: string;
  /** --suite: scope test-side to a named suite */
  suite?: string;
  /** --tag: scope spec-side to a tag group */
  tag?: string;
  /** --uncovered: show only uncovered endpoints */
  uncovered?: boolean;
  /** --format: output format */
  format?: 'pretty' | 'json' | 'markdown';
  /** cwd override */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TestEntry {
  name: string;
  file: string;           // relative path from cwd
  collection: string;
  staticPath: string;     // raw request.path from YAML
  method: string;         // normalized to uppercase
  tags: string[];
  matchedSpecKey?: string; // "GET /api/graph/nodes" — set after matching
}

interface SpecEndpoint {
  method: string;         // uppercase
  path: string;           // raw OAS path e.g. /api/graph/nodes/{path}
  tag?: string;
  summary?: string;
  tests: TestEntry[];     // populated during match phase
}

// ---------------------------------------------------------------------------
// Minimal OpenAPI 3 types (only what we need)
// ---------------------------------------------------------------------------

interface OpenApiSpec {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  tags?: Array<{ name: string; description?: string }>;
}

interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
}

interface OperationObject {
  tags?: string[];
  summary?: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function coverage(args: CoverageArgs): Promise<number> {
  const cwd = args.cwd ?? process.cwd();

  // 1. Load config
  let config: ShogunConfig;
  try {
    config = loadConfig(cwd);
  } catch {
    config = { version: 1 as const };
  }

  // 2. Load env (optional — needed when spec is a live relative URL)
  let env: Record<string, string> = {};
  const envName = args.env ?? config.defaults?.env;
  if (envName) {
    try {
      env = loadEnv(envName, config, cwd);
    } catch {
      // swallow — env may not be needed if spec is a local file or full URL
    }
  }

  // 3. Fetch + parse spec
  let openApi: OpenApiSpec;
  try {
    const result = await fetchSpec(args.specSource, config, env, cwd);
    openApi = JSON.parse(result.raw) as OpenApiSpec;
  } catch (err) {
    console.error(`Error fetching/parsing spec: ${(err as Error).message}`);
    return 1;
  }

  // 4. Extract spec endpoints (with optional tag filter)
  const specEndpoints = extractSpecEndpoints(openApi, args.tag);

  // 5. Collect test entries (with optional collection/suite filter)
  let testEntries: TestEntry[];
  try {
    testEntries = await collectTestEntries(config, cwd, args.collection, args.suite);
  } catch (err) {
    console.error(`Error scanning tests: ${(err as Error).message}`);
    return 1;
  }

  if (testEntries.length === 0 && !args.suite && !args.collection) {
    console.error('No test files found. Is the tests/collections directory present?');
    return 1;
  }

  // 6. Match tests → spec endpoints
  matchTests(testEntries, specEndpoints);

  // 7. Render
  const format = args.format ?? 'pretty';
  renderCoverage(openApi, specEndpoints, testEntries, format, args.uncovered ?? false);

  return 0;
}

// ---------------------------------------------------------------------------
// Step 4: Extract spec endpoints
// ---------------------------------------------------------------------------

function extractSpecEndpoints(openApi: OpenApiSpec, tagFilter?: string): SpecEndpoint[] {
  const paths = openApi.paths ?? {};
  const tagLower = tagFilter?.toLowerCase();
  const endpoints: SpecEndpoint[] = [];

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method as keyof PathItem] as OperationObject | undefined;
      if (!op) continue;

      // Apply tag filter (spec-side)
      if (tagLower) {
        const hasTag = op.tags?.some(t => t.toLowerCase() === tagLower) ?? false;
        if (!hasTag) continue;
      }

      endpoints.push({
        method: method.toUpperCase(),
        path: pathKey,
        tag: op.tags?.[0],
        summary: op.summary,
        tests: [],
      });
    }
  }

  return endpoints;
}

// ---------------------------------------------------------------------------
// Step 5: Collect test entries
// ---------------------------------------------------------------------------

async function collectTestEntries(
  config: ShogunConfig,
  cwd: string,
  collectionFilter?: string,
  suiteFilter?: string,
): Promise<TestEntry[]> {
  const testsDir = join(cwd, config.paths?.tests ?? 'tests');
  const collectionsDir = join(testsDir, 'collections');

  // Determine which collections to scan
  let collectionNames: string[];

  if (suiteFilter) {
    const suite = loadSuite(suiteFilter, config, cwd);
    collectionNames = suite.collections;
  } else if (collectionFilter) {
    collectionNames = [collectionFilter];
  } else {
    collectionNames = discoverCollections(config, cwd);
  }

  const entries: TestEntry[] = [];

  for (const collectionName of collectionNames) {
    const collectionDir = join(collectionsDir, collectionName);
    if (!existsSync(collectionDir)) continue;

    const yamlFiles = readdirSync(collectionDir)
      .filter(f => f.endsWith('.yaml') && f !== '_collection.yaml');

    for (const file of yamlFiles) {
      const filePath = join(collectionDir, file);
      const relPath = join('tests', 'collections', collectionName, file);

      let parsed: unknown;
      try {
        parsed = yaml.load(readFileSync(filePath, 'utf8'));
      } catch {
        // Skip unreadable files silently — lint command handles validation
        continue;
      }

      const p = parsed as Record<string, unknown>;
      const req = p['request'] as Record<string, unknown> | undefined;
      if (!req) continue;

      const rawMethod = req['method'];
      const rawPath = req['path'];
      if (typeof rawMethod !== 'string' || typeof rawPath !== 'string') continue;

      const rawTags = p['tags'];
      const tags = Array.isArray(rawTags) ? (rawTags as string[]) : [];
      const name = typeof p['name'] === 'string' ? p['name'] : file.replace(/\.yaml$/, '');

      entries.push({
        name,
        file: relPath,
        collection: collectionName,
        staticPath: rawPath,
        method: rawMethod.toUpperCase(),
        tags,
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Step 6: Match tests → spec endpoints
// ---------------------------------------------------------------------------

function matchTests(testEntries: TestEntry[], specEndpoints: SpecEndpoint[]): void {
  for (const test of testEntries) {
    const match = matchTestToSpecEndpoint(test.method, test.staticPath, specEndpoints);
    if (match) {
      test.matchedSpecKey = `${match.method} ${match.path}`;
      match.tests.push(test);
    }
  }
}

/**
 * Three-tier path matching algorithm.
 *
 * TIER 1: Exact match on method + path
 * TIER 2: Segment-count-equal template match (wildcard segment alignment)
 * TIER 3: Prefix fallback for multi-segment dynamic tails
 */
function matchTestToSpecEndpoint(
  method: string,
  testPath: string,
  specEndpoints: SpecEndpoint[],
): SpecEndpoint | undefined {
  const methodUpper = method.toUpperCase();
  const sameMethod = specEndpoints.filter(e => e.method === methodUpper);

  // TIER 1 — exact match
  const exact = sameMethod.find(e => e.path === testPath);
  if (exact) return exact;

  // Normalize test path segments — replace dynamic tokens with sentinel __W__
  const testSegs = testPath.split('/').map(seg => isDynamic(seg) ? '__W__' : seg);

  // TIER 2 — same segment count, template match with scoring
  let bestCandidate: SpecEndpoint | undefined;
  let bestScore = -1;

  for (const endpoint of sameMethod) {
    const specSegs = endpoint.path.split('/').map(seg => /^\{.+\}$/.test(seg) ? '__W__' : seg);
    if (specSegs.length !== testSegs.length) continue;

    let score = 0;
    let mismatch = false;

    for (let i = 0; i < testSegs.length; i++) {
      const t = testSegs[i]!;
      const s = specSegs[i]!;
      if (t === '__W__' || s === '__W__') {
        // wildcard — counts but no score
        continue;
      }
      if (t === s) {
        score++;
      } else {
        mismatch = true;
        break;
      }
    }

    if (!mismatch && score > bestScore) {
      bestScore = score;
      bestCandidate = endpoint;
    }
  }

  if (bestCandidate) return bestCandidate;

  // TIER 3 — prefix fallback for multi-segment dynamic tails
  // Find the static prefix: segments before the first __W__
  const firstWild = testSegs.indexOf('__W__');
  const staticSegs = firstWild >= 0 ? testSegs.slice(0, firstWild) : testSegs;
  const staticPrefix = staticSegs.join('/');

  if (!staticPrefix) return undefined;

  const prefixCandidates = sameMethod.filter(e => {
    return e.path === staticPrefix ||
           e.path.startsWith(staticPrefix + '/');
  });

  if (prefixCandidates.length === 0) return undefined;

  // Pick spec path whose segment count is closest to testPath segment count
  const testSegCount = testSegs.length;
  prefixCandidates.sort((a, b) => {
    const aDiff = Math.abs(a.path.split('/').length - testSegCount);
    const bDiff = Math.abs(b.path.split('/').length - testSegCount);
    return aDiff - bDiff;
  });

  return prefixCandidates[0];
}

function isDynamic(seg: string): boolean {
  return seg === '__placeholder__' ||
         seg.startsWith('${') ||
         (seg.includes('{') && seg.includes('}'));
}

// ---------------------------------------------------------------------------
// Step 7: Render coverage
// ---------------------------------------------------------------------------

interface CoverageSummary {
  apiTitle: string;
  apiVersion: string;
  totalEndpoints: number;
  coveredEndpoints: number;
  uncoveredEndpoints: number;
  totalTests: number;
  collections: number;
  coveragePct: number;
}

function buildSummary(
  openApi: OpenApiSpec,
  specEndpoints: SpecEndpoint[],
  testEntries: TestEntry[],
): CoverageSummary {
  const coveredEndpoints = specEndpoints.filter(e => e.tests.length > 0).length;
  const uncoveredEndpoints = specEndpoints.length - coveredEndpoints;
  const collections = new Set(testEntries.map(t => t.collection)).size;
  const pct = specEndpoints.length > 0
    ? Math.round((coveredEndpoints / specEndpoints.length) * 1000) / 10
    : 0;

  return {
    apiTitle: openApi.info?.title ?? 'API',
    apiVersion: openApi.info?.version ?? 'unknown',
    totalEndpoints: specEndpoints.length,
    coveredEndpoints,
    uncoveredEndpoints,
    totalTests: testEntries.length,
    collections,
    coveragePct: pct,
  };
}

function renderCoverage(
  openApi: OpenApiSpec,
  specEndpoints: SpecEndpoint[],
  testEntries: TestEntry[],
  format: 'pretty' | 'json' | 'markdown',
  uncoveredOnly: boolean,
): void {
  const summary = buildSummary(openApi, specEndpoints, testEntries);

  if (format === 'json') {
    renderJson(summary, specEndpoints, uncoveredOnly);
    return;
  }

  if (format === 'markdown') {
    renderMarkdown(summary, specEndpoints, uncoveredOnly);
    return;
  }

  renderPretty(summary, specEndpoints, uncoveredOnly);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderPretty(
  summary: CoverageSummary,
  specEndpoints: SpecEndpoint[],
  uncoveredOnly: boolean,
): void {
  console.log(`Coverage Report — ${summary.apiTitle} v${summary.apiVersion}`);
  console.log(`  Spec endpoints:  ${summary.totalEndpoints}`);
  console.log(`  Tests scanned:   ${summary.totalTests}  (${summary.collections} collections)`);
  console.log(`  Covered:         ${summary.coveredEndpoints}  (${summary.coveragePct}%)`);
  console.log(`  Uncovered:       ${summary.uncoveredEndpoints}`);
  console.log('');

  const covered = specEndpoints.filter(e => e.tests.length > 0);
  const uncovered = specEndpoints.filter(e => e.tests.length === 0);

  if (!uncoveredOnly && covered.length > 0) {
    console.log(`COVERED (${covered.length})`);
    for (const ep of covered) {
      const methodPad = ep.method.padEnd(7);
      const pathPad = ep.path.padEnd(50);
      const testCount = ep.tests.length;
      const testLabel = testCount === 1 ? '1 test ' : `${testCount} tests`;
      const collectionNames = [...new Set(ep.tests.map(t => t.collection))].join(', ');
      console.log(`  ${methodPad} ${pathPad} ${testLabel.padEnd(8)} ${collectionNames}`);
    }
    console.log('');
  }

  if (uncovered.length > 0) {
    console.log(`UNCOVERED (${uncovered.length})`);
    for (const ep of uncovered) {
      const methodPad = ep.method.padEnd(7);
      console.log(`  ${methodPad} ${ep.path}`);
    }
    console.log('');
  }

  const tips: string[] = [];
  if (!uncoveredOnly) tips.push('--uncovered to see only gaps');
  tips.push('--format markdown to embed in a doc');
  console.log(`Tip: ${tips.join('  |  ')}`);
}

function renderMarkdown(
  summary: CoverageSummary,
  specEndpoints: SpecEndpoint[],
  uncoveredOnly: boolean,
): void {
  console.log('## API Coverage Report\n');
  console.log(
    `> ${summary.coveredEndpoints} / ${summary.totalEndpoints} endpoints covered ` +
    `(${summary.coveragePct}%) · ${summary.totalTests} tests · ${summary.collections} collections\n`
  );

  console.log('| Status | Method | Endpoint | Tests | Collections |');
  console.log('|--------|--------|----------|-------|-------------|');

  for (const ep of specEndpoints) {
    if (uncoveredOnly && ep.tests.length > 0) continue;
    const status = ep.tests.length > 0 ? '✅' : '❌';
    const testCount = ep.tests.length > 0 ? String(ep.tests.length) : '0';
    const collectionNames = ep.tests.length > 0
      ? [...new Set(ep.tests.map(t => t.collection))].join(', ')
      : '—';
    console.log(`| ${status} | ${ep.method} | \`${ep.path}\` | ${testCount} | ${collectionNames} |`);
  }
}

function renderJson(
  summary: CoverageSummary,
  specEndpoints: SpecEndpoint[],
  uncoveredOnly: boolean,
): void {
  const endpoints = specEndpoints
    .filter(ep => !uncoveredOnly || ep.tests.length === 0)
    .map(ep => ({
      method: ep.method,
      path: ep.path,
      tag: ep.tag,
      summary: ep.summary,
      covered: ep.tests.length > 0,
      tests: ep.tests.map(t => ({
        name: t.name,
        file: t.file,
        collection: t.collection,
        staticPath: t.staticPath,
        tags: t.tags,
      })),
    }));

  console.log(JSON.stringify({ summary, endpoints }, null, 2));
}
