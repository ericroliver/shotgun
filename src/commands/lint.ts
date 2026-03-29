/**
 * src/commands/lint.ts — banger lint subcommand
 * Validates all YAML test files against the TestDefinition schema (no HTTP calls).
 */

import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, loadTestFile, loadEnv } from '../loader.js';

export interface LintArgs {
  file?: string;
}

export async function lint(args: LintArgs): Promise<number> {
  const config = loadConfig();
  // Use empty env for lint — no env vars needed for schema validation
  const env: Record<string, string> = {};

  let files: string[] = [];

  if (args.file) {
    files = [resolve(args.file)];
  } else {
    files = discoverAllTestFiles(config);
  }

  if (files.length === 0) {
    console.log('No test files found.');
    return 0;
  }

  let errorCount = 0;

  console.log(`Linting ${files.length} file(s)...\n`);

  for (const file of files) {
    try {
      loadTestFile(file, env);
      console.log(`  ✓ ${file}`);
    } catch (err) {
      errorCount++;
      console.error(`  ✗ ${file}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('');

  if (errorCount > 0) {
    console.error(`${errorCount} file(s) failed validation.`);
    return 1;
  }

  console.log(`All ${files.length} file(s) valid.`);
  return 0;
}

function discoverAllTestFiles(config: ReturnType<typeof loadConfig>): string[] {
  const collectionsDir = join(process.cwd(), config.paths?.tests ?? 'tests', 'collections');
  if (!existsSync(collectionsDir)) return [];

  const files: string[] = [];
  const collections = readdirSync(collectionsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const col of collections) {
    const colDir = join(collectionsDir, col);
    const yamlFiles = readdirSync(colDir)
      .filter(f => f.endsWith('.yaml') && f !== '_collection.yaml');
    for (const f of yamlFiles) {
      files.push(join(colDir, f));
    }
  }

  return files;
}
