/**
 * src/reporter.ts
 * Formats and prints run results to stdout.
 * Supports: pretty (default), json, tap formats.
 */

import path from 'node:path';
import type { RunSummary, TestResult, AssertionResults } from './types.js';

// ---------------------------------------------------------------------------
// ANSI colors (disabled when not a TTY)
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY;

const c = {
  reset:  isTTY ? '\x1b[0m'  : '',
  bold:   isTTY ? '\x1b[1m'  : '',
  dim:    isTTY ? '\x1b[2m'  : '',
  green:  isTTY ? '\x1b[32m' : '',
  red:    isTTY ? '\x1b[31m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan:   isTTY ? '\x1b[36m' : '',
  gray:   isTTY ? '\x1b[90m' : '',
};

// ---------------------------------------------------------------------------
// Live progress (printed during run)
// ---------------------------------------------------------------------------

export function printTestStart(name: string, method: string, path: string): void {
  process.stdout.write(`  ${c.cyan}→${c.reset} ${c.dim}${method}${c.reset} ${path} ${c.dim}(${name})${c.reset} ... `);
}

export function printTestResult(result: TestResult): void {
  const httpCode = result.httpStatus != null ? `${result.httpStatus} ` : '';
  switch (result.status) {
    case 'passed':
      process.stdout.write(`${c.green}${httpCode}OK${c.reset} ${c.dim}${result.durationMs}ms${c.reset}${formatTimings(result)}\n`);
      break;
    case 'failed': {
      process.stdout.write(`${c.red}${httpCode}FAIL${c.reset}\n`);
      const reasons = getFailureReasons(result.assertions);
      for (const r of reasons) {
        console.log(`    ${c.red}✗${c.reset} ${r}`);
      }
      if (result.assertions.snapshotDiff) {
        const diffLines = result.assertions.snapshotDiff.split('\n').slice(0, 20);
        for (const line of diffLines) {
          if (line.startsWith('-')) {
            console.log(`    ${c.red}${line}${c.reset}`);
          } else if (line.startsWith('+')) {
            console.log(`    ${c.green}${line}${c.reset}`);
          } else {
            console.log(`    ${c.dim}${line}${c.reset}`);
          }
        }
      }
      if (result.error) {
        console.log(`    ${c.red}Error: ${result.error}${c.reset}`);
      }

      // ── Request / Response telemetry ────────────────────────────────────
      if (result.resolvedRequest || result.resolvedResponse) {
        console.log(`    ${c.dim}── request ────────────────────────────────────${c.reset}`);
        if (result.resolvedRequest) {
          const req = result.resolvedRequest;
          console.log(`    ${c.dim}│ ${c.reset}${c.bold}${req.method}${c.reset} ${req.url}`);
          // Headers — redact Authorization value
          const headers = { ...req.headers };
          if (headers['Authorization']) {
            headers['Authorization'] = headers['Authorization'].replace(/(Bearer\s+)(.{4}).*/, '$1$2…');
          }
          if (Object.keys(headers).length) {
            for (const [k, v] of Object.entries(headers)) {
              console.log(`    ${c.dim}│   ${k}: ${v}${c.reset}`);
            }
          }
          if (req.params && Object.keys(req.params).length) {
            console.log(`    ${c.dim}│   query: ${JSON.stringify(req.params)}${c.reset}`);
          }
          if (req.body !== undefined) {
            const bodyStr = typeof req.body === 'string'
              ? req.body
              : JSON.stringify(req.body, null, 2);
            const snippet = bodyStr.length > 800 ? bodyStr.slice(0, 800) + '…' : bodyStr;
            console.log(`    ${c.dim}│   body: ${snippet}${c.reset}`);
          }
        }

        if (result.resolvedResponse) {
          const res = result.resolvedResponse;
          const statusColor = res.status >= 400 ? c.red : res.status >= 300 ? c.yellow : c.green;
          console.log(`    ${c.dim}── response ───────────────────────────────────${c.reset}`);
          console.log(`    ${c.dim}│ ${c.reset}${statusColor}${c.bold}${res.status}${c.reset}  ${c.dim}${res.curlMs}ms${c.reset}`);
          // Response headers
          if (Object.keys(res.headers).length) {
            for (const [k, v] of Object.entries(res.headers)) {
              console.log(`    ${c.dim}│   ${k}: ${v}${c.reset}`);
            }
          }
          // Response body
          const rawBody = typeof res.raw === 'string' ? res.raw : JSON.stringify(res.body);
          const bodySnippet = rawBody.length > 1200 ? rawBody.slice(0, 1200) + '…' : rawBody;
          if (bodySnippet.trim()) {
            console.log(`    ${c.dim}│   body:${c.reset}`);
            for (const line of bodySnippet.split('\n')) {
              console.log(`    ${c.dim}│     ${line}${c.reset}`);
            }
          }
        }
        console.log(`    ${c.dim}──────────────────────────────────────────────${c.reset}`);
      }
      break;
    }
    case 'needs_baseline':
      process.stdout.write(`${c.yellow}NEEDS BASELINE${c.reset}\n`);
      console.log(`    ${c.yellow}Run: shotgun snapshot to capture baseline${c.reset}`);
      break;
    case 'dependency_failed':
      // Concise: one line names the blocking dep; full detail is on the dep's own output line
      process.stdout.write(`${c.yellow}SKIPPED${c.reset} ${c.dim}(dependency failed)${c.reset}\n`);
      if (result.failedDependency) {
        console.log(`    ${c.dim}↳ blocked by: ${result.failedDependency}${c.reset}`);
      }
      break;
  }

  // Always show script output for failed tests; gate on SHOTGUN_DEBUG for passing
  const showScriptOutput =
    result.status === 'failed'
      ? result.scriptOutput?.length
      : process.env.SHOTGUN_DEBUG && result.scriptOutput?.length;

  if (showScriptOutput) {
    console.log(`    ${c.dim}── script output ─────────────────────────${c.reset}`);
    for (const msg of result.scriptOutput!) {
      console.log(`    ${c.dim}│ ${msg}${c.reset}`);
    }
    console.log(`    ${c.dim}─────────────────────────────────────────${c.reset}`);
  }
}

// ---------------------------------------------------------------------------
// Timing breakdown formatter
// ---------------------------------------------------------------------------

function formatTimings(result: TestResult): string {
  const t = result.timings;
  if (!t) return '';

  const parts: string[] = [];

  parts.push(`curl:${t.curlMs}ms`);

  if (t.preMs > 0) {
    parts.push(`pre:${t.preMs}ms`);
  }

  if (t.assertMs > 0) {
    parts.push(`assert:${t.assertMs}ms`);
  }

  if (t.postMs > 0) {
    parts.push(`post:${t.postMs}ms`);
  }

  if (t.otherMs > 0) {
    parts.push(`other:${t.otherMs}ms`);
  }

  return ` ${c.dim}(${parts.join(', ')})${c.reset}`;
}

export function printCollectionHeader(name: string): void {
  console.log(`\n${c.bold}${c.cyan}◆ ${name}${c.reset}`);
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

export function printSummary(summary: RunSummary): void {
  const { total, passed, failed, needsBaseline, dependencyFailed, durationMs } = summary;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(
    `${c.bold}Run:${c.reset} ${summary.runId}  ` +
    `${c.dim}env: ${summary.env}${c.reset}  ` +
    `${c.dim}${(durationMs / 1000).toFixed(2)}s${c.reset}`,
  );
  console.log('');

  const hasProblem = failed > 0 || dependencyFailed > 0;

  if (hasProblem) {
    // Build a concise status line: only show non-zero counts
    const parts: string[] = [];
    if (failed > 0) parts.push(`${c.red}${c.bold}✗ ${failed} failed${c.reset}`);
    if (dependencyFailed > 0) parts.push(`${c.yellow}${dependencyFailed} skipped (dep failed)${c.reset}`);
    parts.push(`${c.green}${passed} passed${c.reset}`);
    parts.push(`${c.dim}${total} total${c.reset}`);
    console.log(`  ${parts.join('  ')}`);
    console.log('');

    // List root-cause failures (not dependency_failed — those are secondary)
    const rootFailures = summary.results.filter(r => r.status === 'failed');
    if (rootFailures.length > 0) {
      console.log(`  ${c.red}Root cause failures:${c.reset}`);
      for (const result of rootFailures) {
        const rel = path.relative(process.cwd(), result.file);
        console.log(`    ${c.red}✗${c.reset} ${result.name} ${c.dim}(${rel})${c.reset}`);
      }
    }

    // Summarize dependency-blocked tests separately — grouped by blocking dep
    if (dependencyFailed > 0) {
      console.log('');
      console.log(`  ${c.yellow}Blocked by failing dependency:${c.reset}`);
      const byDep = new Map<string, string[]>();
      for (const r of summary.results.filter(res => res.status === 'dependency_failed')) {
        const dep = r.failedDependency ?? '(unknown)';
        if (!byDep.has(dep)) byDep.set(dep, []);
        byDep.get(dep)!.push(r.name);
      }
      for (const [dep, names] of byDep) {
        console.log(`    ${c.dim}${dep}${c.reset} blocked:`);
        for (const n of names) {
          console.log(`      ${c.yellow}⊙${c.reset} ${n}`);
        }
      }
    }
  } else if (needsBaseline > 0) {
    console.log(`  ${c.yellow}${needsBaseline} need baseline${c.reset}  ${c.green}${passed} passed${c.reset}  ${c.dim}${total} total${c.reset}`);
  } else {
    console.log(`  ${c.green}${c.bold}✓ All ${passed} tests passed${c.reset}  ${c.dim}${total} total${c.reset}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Full report (shotgun report command)
// ---------------------------------------------------------------------------

export function printReport(summary: RunSummary, format: 'pretty' | 'json' | 'tap' = 'pretty'): void {
  switch (format) {
    case 'json':
      console.log(JSON.stringify(summary, null, 2));
      break;
    case 'tap':
      printTap(summary);
      break;
    default:
      printPrettyReport(summary);
      break;
  }
}

function printPrettyReport(summary: RunSummary): void {
  printSummary(summary);

  console.log(`${c.bold}Test Results:${c.reset}`);
  console.log('');

  for (const result of summary.results) {
    const icon = result.status === 'passed'
      ? `${c.green}✓${c.reset}`
      : result.status === 'failed'
        ? `${c.red}✗${c.reset}`
        : result.status === 'dependency_failed'
          ? `${c.yellow}⊙${c.reset}`
          : /* needs_baseline */ `${c.yellow}○${c.reset}`;

    const dur = `${c.dim}${result.durationMs}ms${c.reset}`;
    console.log(`  ${icon} ${result.name} ${dur}`);

    if (result.status === 'failed') {
      const reasons = getFailureReasons(result.assertions);
      for (const r of reasons) {
        console.log(`      ${c.red}${r}${c.reset}`);
      }
    } else if (result.status === 'dependency_failed' && result.failedDependency) {
      console.log(`      ${c.dim}↳ blocked by: ${result.failedDependency}${c.reset}`);
    }
  }
  console.log('');
}

function printTap(summary: RunSummary): void {
  console.log(`TAP version 14`);
  console.log(`1..${summary.total}`);
  let i = 1;
  for (const result of summary.results) {
    const ok = result.status === 'passed';
    // TAP: dependency_failed tests are reported as "not ok" with a SKIP directive
    // so CI parsers show them as skipped rather than failures, preserving the
    // root-cause/impact distinction.
    if (result.status === 'dependency_failed') {
      const dep = result.failedDependency ?? 'unknown dependency';
      console.log(`not ok ${i++} - ${result.name} # SKIP blocked by failing dependency: ${dep}`);
    } else {
      console.log(`${ok ? 'ok' : 'not ok'} ${i++} - ${result.name}`);
      if (!ok && result.error) {
        console.log(`  ---`);
        console.log(`  message: '${result.error}'`);
        console.log(`  ...`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFailureReasons(assertions: AssertionResults): string[] {
  const reasons: string[] = [];

  if (assertions.status === false) {
    reasons.push('Status code mismatch');
  }

  const failedShapes = assertions.shape?.filter(s => !s.passed) ?? [];
  for (const s of failedShapes) {
    reasons.push(`Shape assertion failed: ${s.expr}${s.error ? ` — ${s.error}` : ''}`);
  }

  if (assertions.snapshot === false) {
    reasons.push('Snapshot mismatch');
  }

  if (assertions.postScript === false) {
    reasons.push(`Post-script: ${assertions.postScriptError ?? 'assertion failed'}`);
  }

  return reasons;
}
