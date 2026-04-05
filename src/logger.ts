/**
 * src/logger.ts
 * Manages run log directories and writes summary + per-test log files.
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary, TestResult, ShotgunConfig } from './types.js';

export class RunLogger {
  private readonly runId: string;
  private readonly runDir: string;
  private readonly results: TestResult[] = [];
  private startedAt: string;

  constructor(private readonly config: ShotgunConfig, private readonly cwd: string = process.cwd()) {
    this.startedAt = new Date().toISOString();
    this.runId = formatRunId(new Date());
    const runsBase = join(cwd, config.paths?.runs ?? 'runs');
    this.runDir = join(runsBase, this.runId);
    mkdirSync(this.runDir, { recursive: true });
  }

  get id(): string {
    return this.runId;
  }

  /** Write a per-test log file and record the result. */
  recordTest(result: TestResult, collectionName: string): void {
    this.results.push(result);

    if (!this.config.reporting?.save_passing_logs && result.status === 'passed') {
      return;
    }

    const logName = `${collectionName}--${safeFileName(result.name)}.log`;
    const logPath = join(this.runDir, logName);
    writeFileSync(logPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  }

  /** Write the final summary.json for this run. */
  finalize(opts: {
    env: string;
    collection?: string;
    suite?: string;
    startedAt?: string;
  }): RunSummary {
    const finishedAt = new Date().toISOString();
    const startedAt = opts.startedAt ?? this.startedAt;

    const passed = this.results.filter(r => r.status === 'passed').length;
    const failed = this.results.filter(r => r.status === 'failed').length;
    const skipped = this.results.filter(r => r.status === 'skipped').length;
    const needsBaseline = this.results.filter(r => r.status === 'needs_baseline').length;

    const summary: RunSummary = {
      runId: this.runId,
      env: opts.env,
      collection: opts.collection,
      suite: opts.suite,
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      total: this.results.length,
      passed,
      failed,
      skipped,
      needsBaseline,
      results: this.results,
    };

    const summaryPath = join(this.runDir, 'summary.json');
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

    return summary;
  }
}

/** Load the latest run summary from the runs directory. */
export function loadLatestRun(config: ShotgunConfig, cwd = process.cwd()): RunSummary | null {
  const runsBase = join(cwd, config.paths?.runs ?? 'runs');
  if (!existsSync(runsBase)) return null;

  const runs = readdirSync(runsBase, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse();

  if (runs.length === 0) return null;
  return loadRunById(runs[0], config, cwd);
}

/** Load a specific run by ID (timestamp string). */
export function loadRunById(runId: string, config: ShotgunConfig, cwd = process.cwd()): RunSummary | null {
  const summaryPath = join(cwd, config.paths?.runs ?? 'runs', runId, 'summary.json');
  if (!existsSync(summaryPath)) return null;

  try {
    return JSON.parse(readFileSync(summaryPath, 'utf8')) as RunSummary;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRunId(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function safeFileName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
