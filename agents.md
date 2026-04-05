# Banger — Agent Context File

> This file is the first thing an AI agent (or new human contributor) should read before touching this project.

---

## What Is Banger?

**Banger** is a shell-first, TypeScript-enhanced API testing CLI.

The core philosophy: use UNIX tools (curl, jq, diff) for HTTP execution and response comparison, and only bring TypeScript in where logic, scripting, or programmability are genuinely needed. No HTTP client libraries. No heavy test frameworks. Just curl pipes and YAML.

**This repo is the banger engine** — the CLI tool itself. The test definitions (YAML) live in a separate "test repo" that the user creates. A reference test repo lives at [`local-dev-test-repo/`](local-dev-test-repo/) and is the integration target for all banger development work.

---

## Key Signposts

### Engine Source (`src/`)

| File | Role |
|------|------|
| [`src/index.ts`](src/index.ts) | CLI entrypoint — parses args, dispatches commands |
| [`src/runner.ts`](src/runner.ts) | Test runner loop — discovers, orders, and executes collections |
| [`src/loader.ts`](src/loader.ts) | Loads `banger.config.yaml`, env files, test YAML, collection YAML |
| [`src/executor.ts`](src/executor.ts) | Spawns curl via `child_process`; captures status, body, headers, duration |
| [`src/asserter.ts`](src/asserter.ts) | Status code checks, jq shape assertions, snapshot diffs |
| [`src/scripter.ts`](src/scripter.ts) | Transpiles and executes inline TypeScript pre/post scripts via `tsx` |
| [`src/logger.ts`](src/logger.ts) | Writes per-test run logs and `summary.json` under `runs/` |
| [`src/reporter.ts`](src/reporter.ts) | Renders pretty/json/tap output to stdout |
| [`src/types.ts`](src/types.ts) | All shared types — `BangerContext`, `TestDefinition`, `RunSummary`, etc. |
| [`src/commands/`](src/commands/) | One file per CLI command (`run`, `snapshot`, `lint`, `report`) |

### Reference Test Repo (`local-dev-test-repo/`)

This is the live integration test bed — banger is run against a real API using this repo.

| Path | Role |
|------|------|
| `local-dev-test-repo/banger.config.yaml` | Config for the local test repo |
| `local-dev-test-repo/envs/local.env` | Local env vars — **gitignored**, copy from `.env.example` |
| `local-dev-test-repo/tests/collections/` | All test collections (one dir per domain) |
| `local-dev-test-repo/tests/suites/` | Named suites (`smoke.yaml`, `gets-all.yaml`) |
| `local-dev-test-repo/expected/` | Snapshot baselines — committed to git |
| `local-dev-test-repo/testing-plans/` | Human-written plans for each collection (living design docs) |
| `local-dev-test-repo/specs/` | OpenAPI spec and API summary for the target API |

### Documentation (`docs/`)

| File | Role |
|------|------|
| [`docs/technical/architecture.md`](docs/technical/architecture.md) | Deep-dive architecture, execution flow, shell/TS split |
| [`docs/product-stories/banger-v1.md`](docs/product-stories/banger-v1.md) | Product stories for v1 scope |
| [`docs/testing-journal.md`](docs/testing-journal.md) | **Tips, tricks, and lessons learned writing banger tests** (sidecar doc) |
| [`docs/sample-test-repo/`](docs/sample-test-repo/) | Canonical sample of what a user's test repo looks like |

---

## Core Concepts (Quick Reference)

### The `BangerContext` (`ctx`)

Every pre/post script and collection setup/teardown receives a `ctx` object. Key properties:

```typescript
ctx.env          // env vars (read-only)
ctx.vars         // mutable cross-test store — persists for the entire run
ctx.request      // current request — mutable in pre-script
ctx.response     // populated after curl — available in post-script
ctx.assert(bool, msg)   // throws BangerAssertionError on false
ctx.skip(reason)        // marks test skipped, terminates pre-script
ctx.log(msg)            // writes to stdout + run log
ctx.http.get/post/put/patch/delete(...)  // programmatic HTTP (NOT curl)
ctx.scripts      // shared helpers from the test repo's scripts/ dir
```

### Execution Order Per Test

```
collection setup (once)
  └── for each test:
        pre-script → curl → jq shape checks → snapshot diff → post-script → log
collection teardown (once, even on failure)
```

### Snapshot Files

Snapshot baselines live in `expected/` keyed as `{collection}/{METHOD}_{path_sanitized}.json`. They are **committed to git**. Running `banger snapshot` captures/updates them; running `banger run` diffs against them.

### Key CLI Commands

```bash
banger run --env local                   # run all tests
banger run --collection graph            # single collection
banger run --suite smoke                 # named suite
banger snapshot --env local              # capture/update all baselines
banger lint                              # validate YAML without HTTP
banger report                            # show last run
```

---

## Project Conventions

### Naming

- Test files: `{verb}-{resource}-{qualifier}.yaml` — e.g., `create-graph-node-a.yaml`, `get-graph-links.yaml`
- Collections: lowercase, hyphenated domain name matching the API path segment
- Snapshot files: auto-derived from method + path — don't create manually

### Variable Stashing Pattern

Create-then-read tests stash IDs/paths into `ctx.vars` so downstream tests can consume them:

```javascript
// post-script of create test:
ctx.vars.createdNodePathA = body.path ?? ctx.vars.testNodePathA;

// pre-script of read/delete test:
const path = ctx.vars.createdNodePathA;
if (!path) ctx.skip('No node path — create test may have failed');
ctx.request.path = `/api/graph/nodes/${path}`;
```

### Snapshot Policy

- **Write tests** (POST/PATCH/PUT/DELETE): always `snapshot: false` — responses contain volatile IDs and timestamps
- **Read tests** (GET): `snapshot: true` with appropriate `ignore_fields` for volatile fields

### Teardown as Safety Net

Collection teardown should attempt cleanup of any `ctx.vars` pointer that is still non-null. It is a safety net, not the primary cleanup path. Individual delete tests clear their own pointers on success.

### Test Node Path Uniqueness

When creating test data, use a timestamp in the path to prevent collisions between parallel or repeated runs:

```javascript
ctx.vars.testNodePathA = `banger-test/node-a-${Date.now()}`;
```

### Auth Wiring

Auth is wired in collection `setup`, not per-test:

```javascript
const raw = (ctx.env.AUTH_TOKEN ?? '').trim();
ctx.vars.authHeader = raw ? (raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`) : null;
```

Each test's `pre` script applies it: `if (ctx.vars.authHeader) ctx.request.headers['Authorization'] = ctx.vars.authHeader;`

---

## Known API Quirks (local-dev-test-repo target)

These are quirks of the **target API** (not banger itself), documented here to save investigation time:

- `DELETE /api/graph/links/{id}` returns **405** — links cannot be deleted via the API. Tests that attempt link deletion should assert 405 and are expected to leave links in place.
- Graph node paths use **real slashes** in URL paths — do **not** `encodeURIComponent` the path separator.
- `POST /api/graph/nodes` returns **200** (not 201) on creation.
- `PATCH /api/graph/nodes/{path}` accepts body with fields to update (e.g., `{"title": "..."}`) and returns 200 with updated object.
- Workspace must be loaded before graph data resolves — `POST /api/workspace/load/{name}` in collection setup.

---

## Build & Dev

```bash
npm run dev                   # run via tsx (no build)
npm run build                 # tsc + postbuild (makes dist/ executable)
npm run test:local            # run all tests against local env
npm run lint:yaml             # validate all YAML files

# Standalone binary
npm run pkg:macos             # bun compile → bin/banger-macos-arm64
npm run pkg:linux             # bun compile → bin/banger-linux-x64
```

---

## What To Read Next

- **If writing new tests**: read [`docs/testing-journal.md`](docs/testing-journal.md) and a testing plan in [`local-dev-test-repo/testing-plans/`](local-dev-test-repo/testing-plans/)
- **If working on the engine**: read [`docs/technical/architecture.md`](docs/technical/architecture.md) then the relevant `src/` file
- **If debugging a run**: check `local-dev-test-repo/runs/{timestamp}/summary.json` and the per-test `.log` files
