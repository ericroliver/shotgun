/**
 * src/commands/lint.ts — shogun lint subcommand
 * Validates all YAML test files against the TestDefinition schema (no HTTP calls).
 *
 * Extended checks:
 *  - dependsOn refs point to real test files
 *  - setup_fixtures refs point to real fixture files
 *  - No circular dependencies in dependsOn chains
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import {
  loadConfig, loadTestFile, loadCollection, loadSetupFixture,
  buildDependencyOrder, resolveTestRef,
} from '../loader.js';

export interface LintArgs {
  file?: string;
}

export async function lint(args: LintArgs): Promise<number> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  // Use empty env for lint — no env vars needed for schema validation
  const env: Record<string, string> = {};

  const testsDir = join(cwd, config.paths?.tests ?? 'tests');
  const collectionsDir = join(testsDir, 'collections');

  let files: string[] = [];

  if (args.file) {
    files = [resolve(args.file)];
  } else {
    files = discoverAllTestFiles(config, cwd);
  }

  if (files.length === 0) {
    console.log('No test files found.');
    return 0;
  }

  let errorCount = 0;

  console.log(`Linting ${files.length} test file(s)...\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Schema validation
  // -------------------------------------------------------------------------

  const validFiles: string[] = [];

  for (const file of files) {
    try {
      loadTestFile(file, env);
      console.log(`  ✓ ${file}`);
      validFiles.push(file);
    } catch (err) {
      errorCount++;
      console.error(`  ✗ ${file}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: Collection-level validation (setup_fixtures + order refs)
  // -------------------------------------------------------------------------

  if (!args.file && existsSync(collectionsDir)) {
    console.log('\nLinting collection definitions...\n');

    const collectionNames = readdirSync(collectionsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const collectionName of collectionNames) {
      const collectionFile = join(collectionsDir, collectionName, '_collection.yaml');
      if (!existsSync(collectionFile)) continue;

      // Try loading the collection (validates schema + order refs)
      try {
        const { definition } = loadCollection(collectionName, config, cwd);

        // Validate setup_fixtures refs
        if (definition.setup_fixtures?.length) {
          for (const fixtureName of definition.setup_fixtures) {
            try {
              loadSetupFixture(fixtureName, config, cwd);
            } catch (err) {
              errorCount++;
              console.error(`  ✗ ${collectionName}/_collection.yaml`);
              console.error(`    setup_fixtures: "${fixtureName}" — ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        console.log(`  ✓ ${collectionName}/_collection.yaml`);
      } catch (err) {
        errorCount++;
        console.error(`  ✗ ${collectionName}/_collection.yaml`);
        console.error(`    ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3: dependsOn validation — ref existence + cycle detection
  // -------------------------------------------------------------------------

  if (!args.file && existsSync(collectionsDir)) {
    console.log('\nChecking dependsOn references...\n');

    // Discover all tests that have dependsOn
    const allCollectionNames = readdirSync(collectionsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('_'))
      .map(d => d.name);

    for (const collectionName of allCollectionNames) {
      const colDir = join(collectionsDir, collectionName);
      const testFileNames = readdirSync(colDir)
        .filter(f => f.endsWith('.yaml') && f !== '_collection.yaml');

      for (const fname of testFileNames) {
        const testName = fname.replace(/\.yaml$/, '');
        const filePath = join(colDir, fname);
        const canonicalId = `${collectionName}/${testName}`;

        // Parse raw YAML to check for dependsOn without full schema validation
        let parsed: Record<string, unknown>;
        try {
          parsed = yaml.load(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
        } catch {
          continue; // Already caught in Phase 1
        }

        const deps = (parsed?.dependsOn as string[] | undefined) ?? [];
        if (deps.length === 0) continue;

        let testOk = true;

        // Check each dep ref resolves to a real file
        for (const depRef of deps) {
          let resolvedId: string;
          let resolvedFile: string;
          try {
            const resolved = resolveTestRef(depRef, collectionName, collectionsDir);
            resolvedId = resolved.canonicalId;
            resolvedFile = resolved.filePath;
          } catch (err) {
            errorCount++;
            testOk = false;
            console.error(`  ✗ ${canonicalId} — dependsOn: "${depRef}"`);
            console.error(`    ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }

          if (!existsSync(resolvedFile)) {
            errorCount++;
            testOk = false;
            console.error(`  ✗ ${canonicalId} — dependsOn: "${depRef}"`);
            console.error(`    File not found: ${resolvedFile}`);
          }
        }

        // Cycle detection for this test
        if (testOk) {
          try {
            buildDependencyOrder(canonicalId, collectionsDir, env);
            console.log(`  ✓ ${canonicalId} (${deps.length} dep${deps.length === 1 ? '' : 's'})`);
          } catch (err) {
            errorCount++;
            console.error(`  ✗ ${canonicalId}`);
            console.error(`    ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }

  console.log('');

  if (errorCount > 0) {
    console.error(`${errorCount} issue(s) found.`);
    return 1;
  }

  console.log(`All checks passed.`);
  return 0;
}

function discoverAllTestFiles(config: ReturnType<typeof loadConfig>, cwd: string = process.cwd()): string[] {
  const collectionsDir = join(cwd, config.paths?.tests ?? 'tests', 'collections');
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
