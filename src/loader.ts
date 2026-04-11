/**
 * src/loader.ts
 * Loads and validates environment files, shotgun.config.yaml,
 * test definition YAML files, and collection definitions.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';
import type {
  ShotgunConfig,
  EnvVars,
  TestDefinition,
  CollectionDefinition,
} from './types.js';

// ---------------------------------------------------------------------------
// Global config
// ---------------------------------------------------------------------------

const ShotgunConfigSchema = z.object({
  version: z.number(),
  defaults: z.object({
    env: z.string().optional(),
    timeout: z.number().optional(),
    follow_redirects: z.boolean().optional(),
    content_type: z.string().optional(),
  }).optional(),
  paths: z.object({
    tests: z.string().optional(),
    envs: z.string().optional(),
    expected: z.string().optional(),
    runs: z.string().optional(),
    scripts: z.string().optional(),
  }).optional(),
  ignore_fields_global: z.array(z.string()).optional(),
  reporting: z.object({
    format: z.enum(['pretty', 'json', 'tap']).optional(),
    on_fail: z.enum(['diff', 'body', 'silent']).optional(),
    save_passing_logs: z.boolean().optional(),
  }).optional(),
});

export function loadConfig(cwd: string = process.cwd()): ShotgunConfig {
  const configPath = join(cwd, 'shotgun.config.yaml');
  if (!existsSync(configPath)) {
    // Return sensible defaults when no config file is present
    return { version: 1 };
  }
  const raw = yaml.load(readFileSync(configPath, 'utf8'));
  const result = ShotgunConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid shotgun.config.yaml:\n${result.error.toString()}`);
  }
  return result.data as ShotgunConfig;
}

// ---------------------------------------------------------------------------
// Environment files
// ---------------------------------------------------------------------------

export function loadEnv(envName: string, config: ShotgunConfig, cwd: string = process.cwd()): EnvVars {
  const envsDir = join(cwd, config.paths?.envs ?? 'envs');
  const envFile = join(envsDir, `${envName}.env`);

  if (!existsSync(envFile)) {
    throw new Error(`Environment file not found: ${envFile}\nAvailable: ${listEnvFiles(envsDir).join(', ')}`);
  }

  const result = dotenvConfig({ path: envFile, override: true });
  if (result.error) {
    throw new Error(`Failed to parse env file ${envFile}: ${result.error.message}`);
  }

  // Return only the vars from this file (dotenv merges into process.env)
  return result.parsed ?? {};
}

function listEnvFiles(envsDir: string): string[] {
  if (!existsSync(envsDir)) return [];
  return readdirSync(envsDir)
    .filter(f => f.endsWith('.env') && !f.endsWith('.env.example'))
    .map(f => f.replace('.env', ''));
}

// ---------------------------------------------------------------------------
// Test definition YAML schema (Zod)
// ---------------------------------------------------------------------------

const RequestBodySchema = z.object({
  inline: z.record(z.unknown()).optional(),
  file: z.string().optional(),
}).optional();

const RequestDefSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1, 'request.path is required'),
  headers: z.record(z.string()).optional(),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: RequestBodySchema,
});

const ResponseDefSchema = z.object({
  status: z.number().int().min(100).max(599).optional(),
  snapshot: z.boolean().optional(),
  ignore_fields: z.array(z.string()).optional(),
  shape: z.array(z.string()).optional(),
}).optional();

const TestDefinitionSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().optional(),
  collection: z.string().optional(),
  tags: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  pre: z.string().optional(),
  request: RequestDefSchema,
  response: ResponseDefSchema,
  post: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Test definition loader
// ---------------------------------------------------------------------------

export function loadTestFile(filePath: string, env: EnvVars): TestDefinition {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`Test file not found: ${absPath}`);
  }

  const raw = readFileSync(absPath, 'utf8');
  const interpolated = interpolateEnv(raw, env);
  const parsed = yaml.load(interpolated);

  const result = TestDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid test file ${absPath}:\n${formatZodError(result.error)}`);
  }

  return result.data as TestDefinition;
}

// ---------------------------------------------------------------------------
// Collection definition loader
// ---------------------------------------------------------------------------

const CollectionDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  order: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  setup: z.string().optional(),
  teardown: z.string().optional(),
});

export function loadCollection(
  collectionName: string,
  config: ShotgunConfig,
  cwd: string = process.cwd(),
): { definition: CollectionDefinition; testFiles: string[] } {
  const testsDir = join(cwd, config.paths?.tests ?? 'tests');
  const collectionsDir = join(testsDir, 'collections');
  const collectionDir = join(collectionsDir, collectionName);

  if (!existsSync(collectionDir)) {
    throw new Error(`Collection directory not found: ${collectionDir}`);
  }

  const collectionFile = join(collectionDir, '_collection.yaml');
  let definition: CollectionDefinition = { name: collectionName };

  if (existsSync(collectionFile)) {
    const raw = yaml.load(readFileSync(collectionFile, 'utf8'));
    const result = CollectionDefSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid _collection.yaml in ${collectionName}:\n${formatZodError(result.error)}`);
    }
    definition = result.data as CollectionDefinition;
  }

  // Discover test files local to this collection
  const localTestFiles = readdirSync(collectionDir)
    .filter(f => f.endsWith('.yaml') && f !== '_collection.yaml')
    .map(f => basename(f, '.yaml'));

  // Resolve ordered entries — supports cross-collection refs: "other-collection/test-name"
  const orderedEntries = definition.order ?? [];
  const resolvedOrdered: string[] = [];
  const resolvedOrderedKeys = new Set<string>(); // "collection/test" keys already added

  for (const entry of orderedEntries) {
    if (entry.includes('/')) {
      // Cross-collection reference: "other-collection/test-name"
      const [refCollection, refTest] = entry.split('/');
      const refFile = join(collectionsDir, refCollection, `${refTest}.yaml`);
      if (!existsSync(refFile)) {
        throw new Error(
          `Cross-collection test reference not found: "${entry}" → ${refFile}\n` +
          `Referenced from collection "${collectionName}" _collection.yaml`
        );
      }
      resolvedOrdered.push(refFile);
      resolvedOrderedKeys.add(entry);
    } else {
      // Local reference — only include if it actually exists in this collection dir
      if (localTestFiles.includes(entry)) {
        resolvedOrdered.push(join(collectionDir, `${entry}.yaml`));
        resolvedOrderedKeys.add(entry);
      }
    }
  }

  // Append any local files not already in the ordered list
  const unordered = localTestFiles
    .filter(f => !resolvedOrderedKeys.has(f))
    .sort()
    .map(f => join(collectionDir, `${f}.yaml`));

  const testFiles = [...resolvedOrdered, ...unordered];

  return { definition, testFiles };
}

// ---------------------------------------------------------------------------
// Collection discovery
// ---------------------------------------------------------------------------

export function discoverCollections(config: ShotgunConfig, cwd: string = process.cwd()): string[] {
  const collectionsDir = join(cwd, config.paths?.tests ?? 'tests', 'collections');
  if (!existsSync(collectionsDir)) return [];

  return readdirSync(collectionsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_'))
    .map(d => d.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Suite loader
// ---------------------------------------------------------------------------

const SuiteSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  collections: z.array(z.string()),
  tags: z.array(z.string()).optional(),
});

export function loadSuite(suiteName: string, config: ShotgunConfig, cwd: string = process.cwd()) {
  const suitesDir = join(cwd, config.paths?.tests ?? 'tests', 'suites');
  const suiteFile = join(suitesDir, `${suiteName}.yaml`);

  if (!existsSync(suiteFile)) {
    throw new Error(`Suite file not found: ${suiteFile}`);
  }

  const raw = yaml.load(readFileSync(suiteFile, 'utf8'));
  const result = SuiteSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid suite file ${suiteFile}:\n${formatZodError(result.error)}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace ${VAR_NAME} tokens in a string with env var values. */
export function interpolateEnv(text: string, env: EnvVars): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    return env[key] ?? process.env[key] ?? `\${${key}}`;
  });
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map(i => `  [${i.path.join('.')}] ${i.message}`)
    .join('\n');
}

/** Sanitize a method + path into a safe filename prefix. */
export function sanitizeName(method: string, path: string): string {
  return `${method}_${path}`
    .replace(/\//g, '_')
    .replace(/[{}]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '');
}
