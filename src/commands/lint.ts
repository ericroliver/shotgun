/**
 * src/commands/lint.ts — shogun lint subcommand
 * Validates all YAML test files against the TestDefinition schema (no HTTP calls).
 *
 * Extended checks:
 *  - dependsOn refs point to real test files
 *  - setup_fixtures refs point to real fixture files
 *  - No circular dependencies in dependsOn chains
 *  - Inline scripts: duplicate const/let/var declarations (TransformError prevention)
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

  // -------------------------------------------------------------------------
  // Phase 4: Inline script static analysis — duplicate variable declarations
  // -------------------------------------------------------------------------

  console.log('\nChecking inline scripts for duplicate declarations...\n');

  // Check test files
  for (const file of files) {
    let parsed: Record<string, unknown>;
    try {
      parsed = yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      continue; // Already caught in Phase 1
    }

    const scriptSlots: Array<{ slot: string; source: string }> = [];
    for (const slot of ['pre', 'post'] as const) {
      const src = parsed?.[slot];
      if (typeof src === 'string' && src.trim()) {
        scriptSlots.push({ slot, source: src });
      }
    }

    for (const { slot, source } of scriptSlots) {
      const dupes = findDuplicateDeclarations(source);
      if (dupes.length > 0) {
        errorCount++;
        console.error(`  ✗ ${file} [${slot}]`);
        for (const { name, lines } of dupes) {
          console.error(`    duplicate declaration: "${name}" declared at lines ${lines.join(', ')}`);
        }
      } else {
        console.log(`  ✓ ${file} [${slot}]`);
      }
    }
  }

  // Check collection setup/teardown scripts
  if (!args.file && existsSync(collectionsDir)) {
    const collectionNames = readdirSync(collectionsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const collectionName of collectionNames) {
      const collectionFile = join(collectionsDir, collectionName, '_collection.yaml');
      if (!existsSync(collectionFile)) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = yaml.load(readFileSync(collectionFile, 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }

      for (const slot of ['setup', 'teardown'] as const) {
        const src = parsed?.[slot];
        if (typeof src === 'string' && src.trim()) {
          const dupes = findDuplicateDeclarations(src);
          if (dupes.length > 0) {
            errorCount++;
            console.error(`  ✗ ${collectionName}/_collection.yaml [${slot}]`);
            for (const { name, lines } of dupes) {
              console.error(`    duplicate declaration: "${name}" declared at lines ${lines.join(', ')}`);
            }
          } else {
            console.log(`  ✓ ${collectionName}/_collection.yaml [${slot}]`);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 5: Inline script static analysis — unsafe encodeURIComponent on
  //          ctx.request.path (should use encodeFilePath from scripts/url.ts)
  // -------------------------------------------------------------------------

  console.log('\nChecking inline scripts for unsafe path encoding...\n');

  const allTestAndCollectionFiles: Array<{ file: string; slots: string[] }> = [];

  for (const file of files) {
    allTestAndCollectionFiles.push({ file, slots: ['pre', 'post'] });
  }

  if (!args.file && existsSync(collectionsDir)) {
    const collectionNames = readdirSync(collectionsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const collectionName of collectionNames) {
      const collectionFile = join(collectionsDir, collectionName, '_collection.yaml');
      if (existsSync(collectionFile)) {
        allTestAndCollectionFiles.push({ file: collectionFile, slots: ['setup', 'teardown'] });
      }
    }
  }

  for (const { file, slots } of allTestAndCollectionFiles) {
    let parsed: Record<string, unknown>;
    try {
      parsed = yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }

    for (const slot of slots) {
      const src = parsed?.[slot];
      if (typeof src !== 'string' || !src.trim()) continue;

      const hits = findUnsafePathEncoding(src);
      if (hits.length > 0) {
        errorCount++;
        console.error(`  ✗ ${file} [${slot}]`);
        for (const { line, lineNo } of hits) {
          console.error(`    line ${lineNo}: encodeURIComponent() on ctx.request.path encodes '/' → '%2F' and breaks file-path routing`);
          console.error(`      ${line.trim()}`);
          console.error(`    Fix: use encodeFilePath() from ctx.scripts.url`);
        }
      } else {
        console.log(`  ✓ ${file} [${slot}]`);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scans an inline script block for duplicate const/let/var declarations
 * at the TOP LEVEL of the script (brace depth 0).
 *
 * `const` is block-scoped in JavaScript, so re-using the same name inside
 * separate `if`/`try`/`for` blocks is legal. The duplicate that esbuild
 * actually rejects is when the same name is declared twice at the same
 * top-level scope with no intervening block boundary.
 *
 * Strategy: track brace nesting depth as we scan line-by-line. Only record
 * declarations found at depth 0. Two depth-0 declarations of the same name
 * are flagged as duplicates.
 *
 * Handles:
 *   const name = ...
 *   let   name = ...
 *   var   name = ...
 *   const { a, b } = ...        (destructuring — each binding extracted)
 *   const [ a, b ] = ...        (array destructuring)
 *
 * Does NOT attempt full AST parsing — intentionally simple because the goal
 * is "catch the obvious duplicate that esbuild would reject at top scope",
 * not "lint all JavaScript".
 */
function findDuplicateDeclarations(
  source: string,
): Array<{ name: string; lines: number[] }> {
  // Track name → [line numbers where declared at depth 0]
  const seen = new Map<string, number[]>();

  const lines = source.split('\n');

  // Matches:  const NAME    let NAME    var NAME
  const simpleRe = /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:[:=,;)]|$)/;
  // Matches destructuring:  const { a, b: c, ...rest }  or  const [a, b]
  const destructureRe = /^\s*(?:const|let|var)\s*[{[](.*?)[}\]]/;

  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];

    // Skip comment lines
    if (/^\s*\/\//.test(line)) continue;

    // Count brace changes on this line (ignoring strings/template literals — good enough for short scripts)
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    // Only record declarations at top level (depth 0 BEFORE any braces on this line open)
    if (depth === 0) {
      const simpleMatch = simpleRe.exec(line);
      if (simpleMatch) {
        const name = simpleMatch[1];
        if (!seen.has(name)) seen.set(name, []);
        seen.get(name)!.push(lineNo);
      } else {
        const destructureMatch = destructureRe.exec(line);
        if (destructureMatch) {
          const inner = destructureMatch[1];
          for (const part of inner.split(',')) {
            const cleaned = part
              .replace(/\.\.\./g, '')
              .replace(/.*:\s*/g, '')
              .replace(/\s*=.*/g, '')
              .trim();
            if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cleaned)) {
              if (!seen.has(cleaned)) seen.set(cleaned, []);
              seen.get(cleaned)!.push(lineNo);
            }
          }
        }
      }
    }

    depth += opens - closes;
    if (depth < 0) depth = 0; // guard against template literals / object literals in expressions
  }

  // Return only the names that appear more than once at top level
  const dupes: Array<{ name: string; lines: number[] }> = [];
  for (const [name, lineNos] of seen) {
    if (lineNos.length > 1) {
      dupes.push({ name, lines: lineNos });
    }
  }
  return dupes;
}

/**
 * Scans an inline script block for lines that build `ctx.request.path` using
 * bare `encodeURIComponent()` around a file-path or dir-path variable.
 *
 * The Enigma/TinyAST API uses real '/' as path separators — encodeURIComponent
 * converts '/' to '%2F' which breaks routing (returns 404). The fix is to use
 * `encodeFilePath()` from `ctx.scripts.url` which encodes per segment.
 *
 * Detection heuristic: a line that contains BOTH:
 *   - `ctx.request.path` (assignment to the path)
 *   - `encodeURIComponent(` with an argument whose name contains "path" or "dir"
 *     (case-insensitive), e.g. filePath, dirPath, FILE_PATH
 *
 * Identifiers like className, methodName, checkpointId, patternName do NOT
 * match the heuristic — encodeURIComponent is correct for those because they
 * will never contain forward-slash path separators.
 */
function findUnsafePathEncoding(
  source: string,
): Array<{ lineNo: number; line: string }> {
  const hits: Array<{ lineNo: number; line: string }> = [];
  const lines = source.split('\n');

  // Matches encodeURIComponent(somePathOrDirVariable) where variable name
  // contains "path" or "dir" (case-insensitive).
  const unsafeRe = /encodeURIComponent\(([A-Za-z_$][A-Za-z0-9_$]*)\)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines
    if (/^\s*\/\//.test(line)) continue;

    if (!line.includes('ctx.request.path') || !line.includes('encodeURIComponent(')) continue;

    // Check if any encodeURIComponent call argument looks like a file/dir path variable
    unsafeRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    let foundPathArg = false;
    while ((match = unsafeRe.exec(line)) !== null) {
      const argName = match[1];
      if (/path|dir/i.test(argName)) {
        foundPathArg = true;
        break;
      }
    }

    if (foundPathArg) {
      hits.push({ lineNo: i + 1, line });
    }
  }

  return hits;
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
