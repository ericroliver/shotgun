/**
 * src/asserter.ts
 * Runs all assertions against a response:
 *   - HTTP status code
 *   - jq shape expressions (shell)
 *   - Snapshot diff (shell: jq -S | diff -u)
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  ShotgunResponse,
  TestDefinition,
  ShotgunConfig,
  AssertionResults,
  ShapeAssertionResult,
} from './types.js';
import { sanitizeName } from './loader.js';

export interface AssertContext {
  test: TestDefinition;
  response: ShotgunResponse;
  config: ShotgunConfig;
  cwd: string;
  collectionName?: string;
  /** When true: write snapshot instead of diffing */
  snapshotMode?: boolean;
}

export async function runAssertions(ctx: AssertContext): Promise<AssertionResults> {
  const results: AssertionResults = {};

  // 1. Status code
  if (ctx.test.response?.status !== undefined) {
    results.status = ctx.response.status === ctx.test.response.status;
  }

  // 2. jq shape assertions
  if (ctx.test.response?.shape?.length) {
    results.shape = await runShapeAssertions(ctx.response.raw, ctx.test.response.shape);
  }

  // 3. Snapshot
  if (ctx.test.response?.snapshot) {
    const snapResult = await runSnapshotAssertion(ctx);
    results.snapshot = snapResult.passed;
    results.snapshotDiff = snapResult.diff ?? null;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Status assertion
// ---------------------------------------------------------------------------

export function assertStatus(actual: number, expected: number): boolean {
  return actual === expected;
}

// ---------------------------------------------------------------------------
// jq shape assertions
// ---------------------------------------------------------------------------

async function runShapeAssertions(
  rawBody: string,
  expressions: string[],
): Promise<ShapeAssertionResult[]> {
  const results: ShapeAssertionResult[] = [];

  for (const expr of expressions) {
    const result = await runJqExpression(rawBody, expr);
    results.push(result);
  }

  return results;
}

async function runJqExpression(jsonInput: string, expr: string): Promise<ShapeAssertionResult> {
  return new Promise((resolve) => {
    const proc = spawn('jq', ['-e', expr], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.stdin.write(jsonInput);
    proc.stdin.end();

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ expr, passed: true });
      } else {
        resolve({
          expr,
          passed: false,
          error: stderr.trim() || `jq expression evaluated to false/null: ${expr}`,
        });
      }
    });

    proc.on('error', (err) => {
      resolve({ expr, passed: false, error: `jq error: ${err.message}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Snapshot assertions
// ---------------------------------------------------------------------------

interface SnapshotResult {
  passed: boolean;
  diff?: string;
  needsBaseline?: boolean;
}

async function runSnapshotAssertion(ctx: AssertContext): Promise<SnapshotResult> {
  const expectedPath = getExpectedPath(ctx);

  if (ctx.snapshotMode) {
    await writeSnapshot(ctx.response.raw, ctx.test, ctx.config, expectedPath);
    return { passed: true };
  }

  if (!existsSync(expectedPath)) {
    return { passed: false, needsBaseline: true };
  }

  const ignoreFields = [
    ...(ctx.config.ignore_fields_global ?? []),
    ...(ctx.test.response?.ignore_fields ?? []),
  ];

  const normalizedActual = await normalizeJson(ctx.response.raw, ignoreFields);
  const expectedRaw = readFileSync(expectedPath, 'utf8');
  const normalizedExpected = await normalizeJson(expectedRaw, ignoreFields);

  if (normalizedActual === normalizedExpected) {
    return { passed: true };
  }

  const diff = await runDiff(normalizedExpected, normalizedActual);
  return { passed: false, diff };
}

export async function writeSnapshot(
  raw: string,
  test: TestDefinition,
  config: ShotgunConfig,
  expectedPath?: string,
): Promise<void> {
  const path = expectedPath ?? getExpectedPathFromTest(test, config);
  const ignoreFields = [
    ...(config.ignore_fields_global ?? []),
    ...(test.response?.ignore_fields ?? []),
  ];
  const normalized = await normalizeJson(raw, ignoreFields);

  // Refuse to write a blank baseline — this happens when the API is unreachable
  // and the raw response body is empty. Writing blank would silently corrupt the
  // snapshot file and cause every subsequent run to fail with a confusing diff.
  if (!normalized.trim()) {
    if (process.env.SHOTGUN_DEBUG) {
      console.warn(`[asserter] writeSnapshot skipped for "${path}" — normalized content is empty (API may be unreachable)`);
    }
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, normalized + '\n', 'utf8');
}

function getExpectedPath(ctx: AssertContext): string {
  return getExpectedPathFromTest(ctx.test, ctx.config, ctx.cwd, ctx.collectionName);
}

export function getExpectedPathFromTest(
  test: TestDefinition,
  config: ShotgunConfig,
  cwd = process.cwd(),
  collectionName?: string,
): string {
  const expectedDir = join(cwd, config.paths?.expected ?? 'expected');
  const collection = collectionName ?? test.collection ?? 'default';
  const safeName = sanitizeName(test.request.method, test.request.path);
  return join(expectedDir, collection, `${safeName}.json`);
}

// ---------------------------------------------------------------------------
// JSON normalization: strip ignore_fields, sort keys via jq -S
// ---------------------------------------------------------------------------

async function normalizeJson(raw: string, ignoreFields: string[]): Promise<string> {
  if (!raw.trim()) return '';

  let jqExpr = '.';
  for (const field of ignoreFields) {
    // Convert glob-style "**.field" to jq del() expression
    const jqPath = globToJqDel(field);
    jqExpr = `(${jqExpr}) | ${jqPath}`;
  }
  jqExpr = `(${jqExpr}) | . as $x | $x`;

  // Use jq -S to sort keys + apply del() expressions
  const sortedExpr = `${jqExpr.replace(/^\((.+)\) \| \. as \$x \| \$x$/, '$1')}`;

  return new Promise((resolve) => {
    const proc = spawn('jq', ['-S', sortedExpr], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.stdin.write(raw);
    proc.stdin.end();

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // Fallback: return raw if jq fails (e.g. non-JSON response)
        if (process.env.SHOTGUN_DEBUG) {
          console.error(`[asserter] jq normalize failed: ${stderr}`);
        }
        resolve(raw.trim());
      }
    });

    proc.on('error', () => resolve(raw.trim()));
  });
}

function globToJqDel(field: string): string {
  // "**.timestamp" → del(.. | objects | .timestamp?)
  // ".timestamp"   → del(.timestamp)
  // "**.id"        → del(.. | objects | .id?)
  if (field.startsWith('**.')) {
    const key = field.slice(3);
    return `del(.. | objects | .${key}?)`;
  }
  return `del(${field})`;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

async function runDiff(expected: string, actual: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('diff', ['-u', '--label', 'expected', '--label', 'actual', '-', '/dev/stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });

    // Write expected to stdin via first input, actual via /dev/stdin trick won't work cross-platform
    // Use process substitution workaround: write both to tmp, diff them
    proc.on('error', () => resolve('(diff unavailable)'));

    // Simpler: use diff with two named file descriptors via shell
    // Actually let's use a pure Node comparison and format the diff ourselves
    proc.kill();

    resolve(formatSimpleDiff(expected, actual));
  });
}

function formatSimpleDiff(expected: string, actual: string): string {
  const expLines = expected.split('\n');
  const actLines = actual.split('\n');
  const maxLen = Math.max(expLines.length, actLines.length);
  const diffLines: string[] = ['--- expected', '+++ actual'];

  let hasDiff = false;
  for (let i = 0; i < maxLen; i++) {
    const e = expLines[i];
    const a = actLines[i];
    if (e !== a) {
      hasDiff = true;
      if (e !== undefined) diffLines.push(`- ${e}`);
      if (a !== undefined) diffLines.push(`+ ${a}`);
    } else {
      diffLines.push(`  ${e}`);
    }
  }

  return hasDiff ? diffLines.join('\n') : '';
}

export function assertionsAllPassed(results: AssertionResults): boolean {
  if (results.status === false) return false;
  if (results.shape?.some(s => !s.passed)) return false;
  if (results.snapshot === false) return false;
  if (results.postScript === false) return false;
  return true;
}
