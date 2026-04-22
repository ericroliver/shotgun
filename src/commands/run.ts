/**
 * src/commands/run.ts — shogun run subcommand
 */

import { runTests } from '../runner.js';
import { printReport } from '../reporter.js';

export interface RunArgs {
  env?: string;
  collection?: string;
  tags?: string[];
  suite?: string;
  file?: string;
  format?: 'pretty' | 'json' | 'tap';
}

export async function run(args: RunArgs): Promise<number> {
  try {
    const summary = await runTests({
      env: args.env,
      collection: args.collection,
      tags: args.tags,
      suite: args.suite,
      file: args.file,
      format: args.format,
    });

    if (args.format === 'json') {
      printReport(summary, 'json');
    } else if (args.format === 'tap') {
      printReport(summary, 'tap');
    }

    return summary.failed > 0 ? 1 : 0;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
