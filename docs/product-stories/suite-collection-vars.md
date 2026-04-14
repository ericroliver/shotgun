# Engine Story — `vars:` Blocks for Suites and Collections

> Status: Ready for implementation  
> Scope: shotgun engine (`src/types.ts`, `src/loader.ts`, `src/runner.ts`)  
> Related: [`docs/product-stories/api-testapp-1-full-testing.md`](./api-testapp-1-full-testing.md)

---

## Problem

`local.env` currently carries two fundamentally different categories of configuration:

| Category | Examples | Character |
|----------|----------|-----------|
| **Infrastructure** | `BASE_URL`, `AUTH_TOKEN`, `TIMEOUT` | *Where* am I talking to? Per-environment (local/QA/prod). Same for every suite. |
| **Test parameters** | `WORKSPACE_NAME`, `FILE_PATH`, `CLASS_NAME` | *What* am I testing? Per-suite/collection. Test design decisions, not environment facts. |

Mixing them in one flat file creates brittleness:

1. **No multi-workspace support in one run.** Smoke tests need `WORKSPACE_NAME=apitesting`. Deep tests need `WORKSPACE_NAME=api-testapp-1`. There is no way to run both suites in a single `shotgun run` — they fight over the same global variable.

2. **Collections can't self-describe.** A test engineer reading `code/_collection.yaml` cannot see what `FILE_PATH` or `CLASS_NAME` is expected — they have to find and read `local.env`. A collection should own its own requirements.

3. **Every collaborator edits the same env file.** Adding a new test that needs a different `FILE_PATH` forces a global env edit that breaks every other test that relied on the old value.

---

## Solution: `vars:` Blocks at Suite and Collection Scope

Add a declarative `vars:` field to both `SuiteDefinition` and `CollectionDefinition`. Values from these blocks are merged into `ctx.vars` **before any setup script or fixture runs**, giving each layer of the test hierarchy ownership of its own configuration.

### Precedence (lowest → highest wins)

```
  .env file                   infrastructure layer — BASE_URL, AUTH_TOKEN, TIMEOUT only
       ↑
  suite vars:                 suite says which workspace/app to use
       ↑
  collection vars:            collection says which specific files/params to use
       ↑
  script ctx.vars assignment  runtime computed values (IDs, tokens, chained data)
       ↑
  CLI --var KEY=VALUE          (future) one-off runtime override without touching any file
```

Higher wins. A collection `vars:` value for `FILE_PATH` overrides a suite `vars:` value. A script assignment always wins over everything declared in YAML. A future `--var` CLI flag wins over everything.

---

## Story 1 — `vars:` on `CollectionDefinition`

**As a** test engineer,  
**I want** to declare `vars:` in `_collection.yaml`,  
**so that** a collection is self-describing about what file paths, class names, and workspace parameters it requires — without those values leaking into or depending on `local.env`.

**Acceptance Criteria:**
- [ ] [`CollectionDefinition`](../../src/types.ts) gains optional `vars?: Record<string, string>`
- [ ] [`CollectionDefSchema`](../../src/loader.ts) (Zod) gains `vars: z.record(z.string()).optional()`
- [ ] [`loadCollection()`](../../src/loader.ts) parses and returns `vars` on the definition object
- [ ] [`runner.ts`](../../src/runner.ts) merges `collectionDef.vars` into `ctx.vars` **before** running `setup_fixtures` and the `setup:` script
- [ ] Existing tests that read `ctx.env.FILE_PATH` continue to work — `ctx.env` is not changed
- [ ] If both `collectionDef.vars.FILE_PATH` and `ctx.env.FILE_PATH` exist, `ctx.vars.FILE_PATH` (from the collection) takes precedence in scripts that check `ctx.vars` first

**Example `_collection.yaml`:**
```yaml
name: Code / AST API
vars:
  FILE_PATH: src/TinyAST.Api/Endpoints/WorkspaceBackupEndpoints.cs
  CLASS_NAME: WorkspaceBackupEndpoints
  METHOD_NAME: CreateBackup
  PROPERTY_NAME: Name
setup: |
  # FILE_PATH is already in ctx.vars — no env var needed
  ctx.log(`FILE_PATH="${ctx.vars.FILE_PATH}"`);
```

**Notes:**
- Collection `vars` are merged on top of any suite `vars` already in `ctx.vars` at the time the collection runs. Collection wins on collision.
- The merge happens once, at collection setup time. Scripts can further overwrite `ctx.vars.*` as they always have.

---

## Story 2 — `vars:` on `SuiteDefinition`

**As a** test engineer,  
**I want** to declare `vars:` in `suite.yaml`,  
**so that** a suite owns its workspace name and other suite-level parameters, enabling multiple suites targeting different workspaces to run from the same `local.env`.

**Acceptance Criteria:**
- [ ] [`SuiteDefinition`](../../src/types.ts) (currently inferred — make it explicit) gains optional `vars?: Record<string, string>`
- [ ] Suite schema in [`loader.ts`](../../src/loader.ts) gains `vars: z.record(z.string()).optional()`
- [ ] [`runner.ts`](../../src/runner.ts) merges `suite.vars` into `ctx.vars` at the start of the run, **before any collection setup** fires
- [ ] Collection `vars:` is merged afterward (overwrites suite vars on collision)
- [ ] Two suites with different `WORKSPACE_NAME` values can be defined and both would work correctly when run individually with `shotgun run --suite <name>`

**Example `tests/suites/smoke.yaml`:**
```yaml
name: Smoke Suite
vars:
  WORKSPACE_NAME: apitesting      # smoke always hits the stable synthetic fixture
collections:
  - system
  - workspace
  - code
  - fs
tags:
  - smoke
```

**Example `tests/suites/api-testapp-1.yaml`:**
```yaml
name: api-testapp-1 Full Suite
vars:
  WORKSPACE_NAME: api-testapp-1   # deep tests target the real todo application
collections:
  - workspace-backup
  - code
  - fs
  - deps
```

**Notes:**
- Suite vars create the baseline `ctx.vars` state for the entire run. Collections then layer on top.
- Running `shotgun run --suite smoke` uses `apitesting`. Running `shotgun run --suite api-testapp-1` uses `api-testapp-1`. No env file change required.
- If `WORKSPACE_NAME` is set in neither suite vars nor collection vars, scripts fall back to `ctx.env.WORKSPACE_NAME` as today — fully backward compatible.

---

## Story 3 — Narrow `.env` Files to Infrastructure Only

**As a** test engineer,  
**I want** `local.env` (and all `.env` files) to contain only infrastructure configuration,  
**so that** the mental model is clean: `.env` = *where*, suite/collection `vars:` = *what*.

**Acceptance Criteria:**
- [ ] `local.env.example` is updated — remove `WORKSPACE_NAME`, `FILE_PATH`, `CLASS_NAME`, `METHOD_NAME`, `PROPERTY_NAME`, `DIR_PATH`, `DB_SCHEMA`, `DB_OBJECT_NAME`, `PROC_NAME`, `VC_*` vars
- [ ] A prominent comment in `local.env.example` reads:
  ```
  # Test parameters (workspace name, file paths, class names, etc.) belong in
  # suite vars: and collection vars: blocks — NOT in this file.
  # This file is for infrastructure only: where is the server, what are the credentials.
  ```
- [ ] `local.env.example` retains: `BASE_URL`, `AUTH_TOKEN`, `TIMEOUT`, `LOG_LEVEL`
- [ ] All existing collection `_collection.yaml` files are updated to move their env-var-sourced parameters into `vars:` blocks (done as part of the api-testapp-1 collection sprint — Story 2.x in the api-testapp-1 plan)
- [ ] Existing setup scripts that read `ctx.env.WORKSPACE_NAME` are updated to: `(ctx.vars.WORKSPACE_NAME ?? ctx.env.WORKSPACE_NAME ?? '').trim()` — explicit fallback for the transition period

**Notes:**
- `local.env` files in the wild (gitignored user copies) should not need to be touched if the user has only infrastructure vars there. Any extra vars remain harmless — they just live in `ctx.env` as before.
- This is a gradual migration, not a flag day. Scripts can read both `ctx.vars` and `ctx.env` during the transition. The pattern `ctx.vars.X ?? ctx.env.X` is the bridge.

---

## Story 4 — Future: `--var KEY=VALUE` CLI Override

**As a** test engineer,  
**I want** to pass `--var FILE_PATH=src/override.cs` on the command line,  
**so that** I can override any `vars:` value for a one-off run without touching any file.

**Acceptance Criteria:**
- [ ] `shotgun run --var KEY=VALUE` (repeatable) accepted by CLI
- [ ] Values from `--var` merge into `ctx.vars` at highest precedence (after all YAML vars and before scripts)
- [ ] `shotgun lint` documents any vars declared in suite/collection as "known parameters" and warns if required vars are not set by any source

**Notes:**
- This story is lower priority — the YAML `vars:` blocks (Stories 1–3) solve the multi-workspace problem immediately. CLI overrides are quality-of-life for power users.
- Implementing this story later is non-breaking: it just extends the precedence chain at the top.

---

## Engine Implementation Notes

### `src/types.ts` changes

```typescript
export interface CollectionDefinition {
  name: string;
  description?: string;
  order?: string[];
  tags?: string[];
  setup_fixtures?: string[];
  setup?: string;
  teardown?: string;
  /** Pre-seeded into ctx.vars before setup runs. Collection vars override suite vars. */
  vars?: Record<string, string>;          // ← NEW
}

export interface SuiteDefinition {        // ← make explicit if not already
  name: string;
  description?: string;
  collections: string[];
  tags?: string[];
  /** Pre-seeded into ctx.vars at run start. Suite vars are overridden by collection vars. */
  vars?: Record<string, string>;          // ← NEW
}
```

### `src/loader.ts` changes

```typescript
const CollectionDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  order: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  setup_fixtures: z.array(z.string()).optional(),
  setup: z.string().optional(),
  teardown: z.string().optional(),
  vars: z.record(z.string()).optional(),  // ← NEW
});

// Suite schema (wherever loadSuite() parses the YAML):
const SuiteSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  collections: z.array(z.string()),
  tags: z.array(z.string()).optional(),
  vars: z.record(z.string()).optional(),  // ← NEW
});
```

### `src/runner.ts` ctx.vars seeding order

```typescript
// When initializing a run:
// 1. Start with empty ctx.vars
const vars: Record<string, unknown> = {};

// 2. Merge suite vars (if suite run)
if (suite?.vars) {
  Object.assign(vars, suite.vars);
}

// 3. Before each collection setup, merge collection vars (overrides suite vars)
if (collectionDef.vars) {
  Object.assign(vars, collectionDef.vars);   // merged AT collection setup time
}

// ctx.vars is now pre-seeded — setup_fixtures and setup scripts run after this
```

> **Important:** Collection vars should be merged at collection setup time (not at run start), so that if two collections in the same suite declare the same var with different values, each collection gets its own value.

---

## Backward Compatibility Guarantee

Every existing test continues to work unchanged:

| Pattern | Before | After | Notes |
|---------|--------|-------|-------|
| `ctx.env.WORKSPACE_NAME` | reads env file | reads env file | unchanged — `ctx.env` not touched |
| `ctx.vars.WORKSPACE_NAME` | undefined (not set) | set from suite/collection vars: | new — scripts that check `ctx.vars` first now get the declared value |
| `ctx.vars.X \|\| ctx.env.X` | falls back to env | uses vars first | the recommended migration pattern |
| Collection without `vars:` | works | works | `vars` is optional |
| Suite without `vars:` | works | works | `vars` is optional |

No test files need to be changed to get the feature. Collections that want to opt in add a `vars:` block. Collections that don't, continue exactly as before.

---

## Migration Path for Existing Collections

For each existing collection `_collection.yaml`:

1. Identify what env vars the collection's setup reads (`ctx.env.WORKSPACE_NAME`, `ctx.env.FILE_PATH`, etc.)
2. Move those values into a `vars:` block in `_collection.yaml`
3. Update the setup script to read `(ctx.vars.WORKSPACE_NAME ?? ctx.env.WORKSPACE_NAME ?? '').trim()` (bridge pattern)
4. Remove those vars from `local.env.example` comments once all collections are migrated

Migration is a collection at a time — there is no big-bang cutover required.
