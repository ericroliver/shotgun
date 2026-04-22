/**
 * src/commands/report.ts — shogun report subcommand
 * Reads run logs and prints a report without executing any tests.
 */

import { loadLatestRun, loadRunById } from '../logger.js';
import { loadConfig } from '../loader.js';
import { printReport } from '../reporter.js';

export interface ReportArgs {
  run?: string;
  format?: 'pretty' | 'json' | 'tap';
}

export async function report(args: ReportArgs): Promise<void> {
  const config = loadConfig();

  const summary = args.run
    ? loadRunById(args.run, config)
    : loadLatestRun(config);

  if (!summary) {
    console.error('No run logs found. Run `shogun run` first.');
    return;
  }

  printReport(summary, args.format ?? 'pretty');
}
