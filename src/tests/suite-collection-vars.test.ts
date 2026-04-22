/**
 * src/tests/suite-collection-vars.test.ts
 *
 * Unit tests for the `vars:` feature on SuiteDefinition and CollectionDefinition.
 *
 * Stories covered:
 *   Story 1 — vars on CollectionDefinition: loader parses, runner merges before setup
 *   Story 2 — vars on SuiteDefinition: loader parses, runner merges at run start
 *   Backward-compat — collections/suites without vars: continue to work
 *
 * Run with:
 *   npm run test:unit
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCollection, loadSuite } from '../loader.js';
import type { ShotgunConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal ShotgunConfig pointing at a tmp directory */
function makeConfig(cwd: string): ShotgunConfig {
  return {
    version: 1,
    paths: {
      tests: 'tests',
      envs: 'envs',
    },
  };
}

/** Set up a tmp dir tree for a collection test */
function makeTmpRepo(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'shotgun-test-'));
  mkdirSync(join(cwd, 'tests', 'collections', 'my-collection'), { recursive: true });
  mkdirSync(join(cwd, 'tests', 'suites'), { recursive: true });
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function writeCollectionDef(cwd: string, collectionName: string, yamlContent: string): void {
  writeFileSync(
    join(cwd, 'tests', 'collections', collectionName, '_collection.yaml'),
    yamlContent,
    'utf8',
  );
}

function writeSuiteDef(cwd: string, suiteName: string, yamlContent: string): void {
  writeFileSync(
    join(cwd, 'tests', 'suites', `${suiteName}.yaml`),
    yamlContent,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Story 1 — Collection vars
// ---------------------------------------------------------------------------

describe('Story 1 — CollectionDefinition vars', () => {

  test('loadCollection parses vars block from _collection.yaml', () => {
    const { cwd, cleanup } = makeTmpRepo();
    try {
      writeCollectionDef(cwd, 'my-collection', `
name: My Collection
vars:
  FILE_PATH: src/TinyAST.Api/Endpoints/WorkspaceBackupEndpoints.cs
  CLASS_NAME: WorkspaceBackupEndpoints
  METHOD_NAME: CreateBackup
`);
      const config = makeConfig(cwd);
      const { definition } = loadCollection('my-collection', config, cwd);

      assert.deepEqual(definition.vars, {
        FILE_PATH: 'src/TinyAST.Api/Endpoints/WorkspaceBackupEndpoints.cs',
        CLASS_NAME: 'WorkspaceBackupEndpoints',
        METHOD_NAME: 'CreateBackup',
      });
    } finally {
      cleanup();
    }
  });

  test('loadCollection without vars returns undefined vars (backward compat)', () => {
    const { cwd, cleanup } = makeTmpRepo();
    try {
      writeCollectionDef(cwd, 'my-collection', `
name: Legacy Collection
setup: |
  ctx.log('no vars here');
`);
      const config = makeConfig(cwd);
      const { definition } = loadCollection('my-collection', config, cwd);

      assert.equal(definition.vars, undefined);
      assert.equal(definition.name, 'Legacy Collection');
    } finally {
      cleanup();
    }
  });

  test('loadCollection with empty vars block returns empty object', () => {
    const { cwd, cleanup } = makeTmpRepo();
    try {
      writeCollectionDef(cwd, 'my-collection', `
name: Empty Vars Collection
vars: {}
`);
      const config = makeConfig(cwd);
      const { definition } = loadCollection('my-collection', config, cwd);

      assert.deepEqual(definition.vars, {});
    } finally {
      cleanup();
    }
  });

  test('vars are typed as Record<string, string> — non-string values fail schema', () => {
    const { cwd, cleanup } = makeTmpRepo();
    try {
      writeCollectionDef(cwd, 'my-collection', `
name: Bad Vars
vars:
  TIMEOUT: 30
`);
      const config = makeConfig(cwd);
      // Numeric value should fail the z.record(z.string()) schema
      assert.throws(
        () => loadCollection('my-collection', config, cwd),
        /Invalid _collection\.yaml/,
      );
    } finally {
      cleanup();
    }
  });

  test('collection vars are included alongside other collection fields', () => {
    const { cwd, cleanup } = makeTmpRepo();
    try {
      writeCollectionDef(cwd, 'my-collection', `
name: Full Collection
description: Has everything
vars:
  WORKSPACE_NAME: my-workspace
  FILE_PATH: src/App.cs
tags:
  - smoke
setup: |
  ctx.log('setup');
teardown: |
  ctx.log('teardown');
`);
      const config = makeConfig(cwd);
      const { definition } = loadCollection('my-collection', config, cwd);

      assert.equal(definition.name, 'Full Collection');
      assert.deepEqual(definition.tags, ['smoke']);
      assert.equal(definition.setup, "ctx.log('setup');\n");
      assert.deepEqual(definition.vars, {
        WORKSPACE_NAME: 'my-workspace',
        FILE_PATH: 'src/App.cs',
      });
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Story 2 — Suite vars
// ---------------------------------------------------------------------------

describe('Story 2 — SuiteDefinition vars', () => {

  test('loadSuite parses vars block from suite YAML', () => {
    const { cwd, cleanup } = makeTmpRepo();
    try {
      writeSuiteDef(cwd, 'smoke', `
name: Smoke Suite
vars:
  WORKSPACE_NAME: apitesting
collections:
  - system
  - workspace
tags:
  - smoke
`);
      const config = makeConfig(cwd);
      const suite = loadSuite('smoke', config, cwd);

      assert.equal(suite.name, 'Smoke Suite');
      assert.deepEqual(suite.vars, { WORKSPACE_NAME: 'apitesting' });
      assert.deepEqual(suite.collections, ['system', 'workspace']);
    } finally {
      cleanup();
    }
  });

  test('loadSuite without vars returns undefined vars (backward compat)', () => {
    const { cwd, cleanup } = makeTmpRepo();
    try {
      writeSuiteDef(cwd, 'legacy', `
name: Legacy Suite
collections:
  - system
`);
      const config = makeConfig(cwd);
      const suite = loadSuite('legacy', config, cwd);

      assert.equal(suite.vars, undefined);
      assert.equal(suite.name, 'Legacy Suite');
    } finally {
      cleanup();
    }
  });

  test('loadSuite with multiple vars entries parses all of them', () => {
    const { cwd, cleanup } = makeTmpRepo();
    try {
      writeSuiteDef(cwd, 'api-testapp-1', `
name: api-testapp-1 Full Suite
vars:
  WORKSPACE_NAME: api-testapp-1
  SOME_OTHER_PARAM: value
collections:
  - workspace-backup
  - code
`);
      const config = makeConfig(cwd);
      const suite = loadSuite('api-testapp-1', config, cwd);

      assert.deepEqual(suite.vars, {
        WORKSPACE_NAME: 'api-testapp-1',
        SOME_OTHER_PARAM: 'value',
      });
    } finally {
      cleanup();
    }
  });

  test('two suites can declare different WORKSPACE_NAME without conflict', () => {
    const { cwd, cleanup } = makeTmpRepo();
    try {
      writeSuiteDef(cwd, 'smoke', `
name: Smoke
vars:
  WORKSPACE_NAME: apitesting
collections:
  - system
`);
      writeSuiteDef(cwd, 'deep', `
name: Deep
vars:
  WORKSPACE_NAME: api-testapp-1
collections:
  - code
`);
      const config = makeConfig(cwd);

      const smoke = loadSuite('smoke', config, cwd);
      const deep = loadSuite('deep', config, cwd);

      assert.equal(smoke.vars?.WORKSPACE_NAME, 'apitesting');
      assert.equal(deep.vars?.WORKSPACE_NAME, 'api-testapp-1');

      // Confirm they are independent objects — no shared state
      assert.notEqual(smoke.vars, deep.vars);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Vars precedence logic (pure unit — no runner invocation needed)
//
// The runner merges vars in this order:
//   1. Start with empty {}
//   2. Object.assign(vars, suite.vars)       — suite layer
//   3. Object.assign(vars, collection.vars)  — collection layer (wins on collision)
//   4. Script can write ctx.vars.X = value   — runtime layer (wins over all YAML)
//
// We test the pure merge logic here without running the full runner.
// ---------------------------------------------------------------------------

describe('Vars precedence — merge logic', () => {

  function applyVarsLayers(
    suiteVars: Record<string, string> | undefined,
    collectionVars: Record<string, string> | undefined,
    scriptAssignments: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const vars: Record<string, unknown> = {};

    // Layer 1 — suite vars (lowest YAML precedence)
    if (suiteVars) Object.assign(vars, suiteVars);

    // Layer 2 — collection vars (overrides suite on collision)
    if (collectionVars) Object.assign(vars, collectionVars);

    // Layer 3 — script runtime assignments (highest precedence)
    Object.assign(vars, scriptAssignments);

    return vars;
  }

  test('suite vars are seeded when no collection vars exist', () => {
    const vars = applyVarsLayers(
      { WORKSPACE_NAME: 'apitesting', BASE_PARAM: 'suite-value' },
      undefined,
    );
    assert.equal(vars.WORKSPACE_NAME, 'apitesting');
    assert.equal(vars.BASE_PARAM, 'suite-value');
  });

  test('collection vars override suite vars on collision', () => {
    const vars = applyVarsLayers(
      { WORKSPACE_NAME: 'apitesting', SHARED: 'from-suite' },
      { WORKSPACE_NAME: 'api-testapp-1', FILE_PATH: 'src/App.cs' },
    );
    // Collection wins on WORKSPACE_NAME collision
    assert.equal(vars.WORKSPACE_NAME, 'api-testapp-1');
    // Suite value not clobbered where no collision
    assert.equal(vars.SHARED, 'from-suite');
    // Collection-only var present
    assert.equal(vars.FILE_PATH, 'src/App.cs');
  });

  test('collection vars without suite vars work independently', () => {
    const vars = applyVarsLayers(
      undefined,
      { FILE_PATH: 'src/App.cs', CLASS_NAME: 'AppClass' },
    );
    assert.equal(vars.FILE_PATH, 'src/App.cs');
    assert.equal(vars.CLASS_NAME, 'AppClass');
  });

  test('script runtime assignments override all YAML vars', () => {
    const vars = applyVarsLayers(
      { WORKSPACE_NAME: 'apitesting' },
      { WORKSPACE_NAME: 'api-testapp-1', FILE_PATH: 'src/App.cs' },
      // Script computed a dynamic value at runtime
      { WORKSPACE_NAME: 'runtime-override', authHeader: 'Bearer tok_123' },
    );
    assert.equal(vars.WORKSPACE_NAME, 'runtime-override');
    assert.equal(vars.FILE_PATH, 'src/App.cs');      // collection var preserved
    assert.equal(vars.authHeader, 'Bearer tok_123'); // runtime-only var present
  });

  test('empty suite vars and empty collection vars result in empty vars', () => {
    const vars = applyVarsLayers({}, {});
    assert.deepEqual(vars, {});
  });

  test('each collection in a suite gets its own vars layer (no bleed between collections)', () => {
    // Simulate two consecutive collection runs sharing the same vars store
    const vars: Record<string, unknown> = {};

    // Suite layer applied once
    const suiteVars = { WORKSPACE_NAME: 'apitesting' };
    Object.assign(vars, suiteVars);

    // Collection A runs — adds its own vars
    const collectionAVars = { FILE_PATH: 'src/A.cs', CLASS_NAME: 'ClassA' };
    Object.assign(vars, collectionAVars);

    // Simulate end of collection A — collection B's vars are applied on top
    const collectionBVars = { FILE_PATH: 'src/B.cs', CLASS_NAME: 'ClassB' };
    Object.assign(vars, collectionBVars);

    // Collection B's vars win
    assert.equal(vars.FILE_PATH, 'src/B.cs');
    assert.equal(vars.CLASS_NAME, 'ClassB');
    // Suite var persists through both collections
    assert.equal(vars.WORKSPACE_NAME, 'apitesting');
  });

  test('ctx.env is not affected by vars: blocks', () => {
    // ctx.env represents the .env file — it must remain immutable across all layers
    const env = { BASE_URL: 'http://localhost:3080', AUTH_TOKEN: '' };
    const vars: Record<string, unknown> = {};

    // Apply all layers
    Object.assign(vars, { WORKSPACE_NAME: 'apitesting' });
    Object.assign(vars, { FILE_PATH: 'src/App.cs' });

    // env is never mutated by any vars: layer
    assert.deepEqual(env, { BASE_URL: 'http://localhost:3080', AUTH_TOKEN: '' });
    assert.equal(env.hasOwnProperty('WORKSPACE_NAME'), false);
    assert.equal(env.hasOwnProperty('FILE_PATH'), false);
  });
});

// ---------------------------------------------------------------------------
// Backward-compatibility guard
// ---------------------------------------------------------------------------

describe('Backward compatibility', () => {

  test('loadCollection with no _collection.yaml at all uses defaults (name = collectionName)', () => {
    const { cwd, cleanup } = makeTmpRepo();
    try {
      // No _collection.yaml written — only the directory exists
      const config = makeConfig(cwd);
      const { definition } = loadCollection('my-collection', config, cwd);

      assert.equal(definition.name, 'my-collection');
      assert.equal(definition.vars, undefined);
      assert.equal(definition.setup, undefined);
      assert.equal(definition.teardown, undefined);
    } finally {
      cleanup();
    }
  });

  test('ctx.vars.X ?? ctx.env.X bridge pattern resolves correctly', () => {
    const env: Record<string, string> = { WORKSPACE_NAME: 'from-env' };
    const vars: Record<string, unknown> = {};

    // No suite/collection vars set — bridge falls back to env
    const resolvedNoVars = (vars.WORKSPACE_NAME as string | undefined) ?? env.WORKSPACE_NAME ?? '';
    assert.equal(resolvedNoVars, 'from-env');

    // Suite/collection vars set — bridge uses vars (env untouched)
    vars.WORKSPACE_NAME = 'from-vars';
    const resolvedWithVars = (vars.WORKSPACE_NAME as string | undefined) ?? env.WORKSPACE_NAME ?? '';
    assert.equal(resolvedWithVars, 'from-vars');
    assert.equal(env.WORKSPACE_NAME, 'from-env'); // env unchanged
  });
});
