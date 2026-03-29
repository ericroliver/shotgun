/**
 * src/commands/snapshot.ts — banger snapshot subcommand
 * Runs tests in snapshot-capture mode: writes expected/ baselines instead of diffing.
 */

import { runTests } from '../runner.js';

export interface SnapshotArgs {
  env?: string;
  collection?: string;
  file?: string;
}

export async function snapshot(args: SnapshotArgs): Promise<number> {
  console.log('📸 Capturing snapshots...\n');
  try {
    const summary = await runTests({
      env: args.env,
      collection: args.collection,
      file: args.file,
      snapshotMode: true,
    });

    const captured = summary.results.filter(r => r.status === 'passed').length;
    console.log(`\nCaptured ${captured} snapshot(s) in expected/`);
    return 0;
  } catch (err) {
    console.error(`Snapshot error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
