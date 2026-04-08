/**
 * src/reporter.ts
 * Formats and prints run results to stdout.
 * Supports: pretty (default), json, tap formats.
 */

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
  switch (result.status) {
    case 'passed':
      process.stdout.write(`${c.green}OK${c.reset} ${c.dim}${result.durationMs}ms${c.reset}\n`);
      break;
    case 'failed': {
      process.stdout.write(`${c.red}FAIL${c.reset}\n`);
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
      break;
    }
    case 'needs_baseline':
      process.stdout.write(`${c.yellow}NEEDS BASELINE${c.reset}\n`);
      console.log(`    ${c.yellow}Run: shotgun snapshot to capture baseline${c.reset}`);
      break;
  }

  // Print script output in debug mode
  if (process.env.SHOTGUN_DEBUG && result.scriptOutput?.length) {
    for (const msg of result.scriptOutput) {
      console.log(`    ${c.dim}[script] ${msg}${c.reset}`);
    }
  }
}

export function printCollectionHeader(name: string): void {
  console.log(`\n${c.bold}${c.cyan}◆ ${name}${c.reset}`);
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

export function printSummary(summary: RunSummary): void {
  const { total, passed, failed, needsBaseline, durationMs } = summary;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(
    `${c.bold}Run:${c.reset} ${summary.runId}  ` +
    `${c.dim}env: ${summary.env}${c.reset}  ` +
    `${c.dim}${(durationMs / 1000).toFixed(2)}s${c.reset}`,
  );
  console.log('');

  if (failed > 0) {
    console.log(`  ${c.red}${c.bold}✗ ${failed} failed${c.reset}  ${c.green}${passed} passed${c.reset}  ${c.dim}${total} total${c.reset}`);
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
    const icon = result.status === 'passed'        ? `${c.green}✓${c.reset}`
      : result.status === 'failed'                 ? `${c.red}✗${c.reset}`
      : /* needs_baseline */                         `${c.yellow}○${c.reset}`;

    const dur = `${c.dim}${result.durationMs}ms${c.reset}`;
    console.log(`  ${icon} ${result.name} ${dur}`);

    if (result.status === 'failed') {
      const reasons = getFailureReasons(result.assertions);
      for (const r of reasons) {
        console.log(`      ${c.red}${r}${c.reset}`);
      }
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
    console.log(`${ok ? 'ok' : 'not ok'} ${i++} - ${result.name}`);
    if (!ok && result.error) {
      console.log(`  ---`);
      console.log(`  message: '${result.error}'`);
      console.log(`  ...`);
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
