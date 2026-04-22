# api-testapp-1 — Full Enigma API Testing Plan

> Status: Phase 1 in progress — `vars:` engine complete, workspace-backup collection being built
> Target workspace: `api-testapp-1` (TypeScript/Svelte/.NET todo application)
> Target server: `http://m1x.local:3080`
> Spec: [`local-dev-test-repo/specs/enigma-api.json`](../../local-dev-test-repo/specs/enigma-api.json)
> Engine: `vars:` at suite and collection level is **implemented** — suite vars seed `ctx.vars` before any collection setup fires; collection vars merge on top (collection wins on collision)

---

## Vision

We have a **real application** (`api-testapp-1` — a TypeScript/Svelte frontend + .NET API todo app) loaded into Enigma as a workspace. This is not a synthetic test fixture — it is a functioning codebase with real structure, real files, and real semantics.

The plan is to exercise Enigma against this real app in five ascending phases:

```
Phase 0  ─── Workspace Pivot + Safety Net
              Switch target to api-testapp-1; prove backup/restore works
              so we can safely mutate and recover

Phase 1  ─── Backup/Restore Lifecycle (new API)
              CRUD coverage of POST/GET/POST-restore/DELETE /api/workspace/backup

Phase 2  ─── Read Primitives (Code Analysis)
              fs, code/AST, deps, index analysis against real app files
              Fill in env vars with concrete todo-app files

Phase 3  ─── Write Primitives
              fs edits, code patches, checkpoints — non-destructive mutations
              Backup → mutate → assert change → restore

Phase 4  ─── Search & Semantic
              FTS, semantic search, embeddings, clones — prove Enigma
              understands the todo app's code semantics

Phase 5  ─── Agent-Driven End-to-End (the big vision)
              Agent receives real instruction → makes real edit → shotgun
              verifies the change via diff/vc/code endpoints → restore
```

The backup/restore capability (Phase 1) is the **keystone** — it gives us a safety net for every destructive test in Phases 3–5. We will always: backup → test → restore.

---

## Phase 0 — Workspace Pivot + Environment Configuration ✅ COMPLETE

### Story 0.1 — Create `api-testapp-1` Suite with `vars: WORKSPACE_NAME` ✅

**As a** test engineer,
**I want** a dedicated `api-testapp-1.yaml` suite that owns its workspace name via `vars:`,
**so that** deep tests always target the real todo app without touching `local.env`, and the smoke suite keeps targeting `apitesting` independently.

**Acceptance Criteria:**
- [x] `local-dev-test-repo/tests/suites/api-testapp-1.yaml` created with `vars: WORKSPACE_NAME: api-testapp-1`
- [x] `local-dev-test-repo/tests/suites/smoke.yaml` updated to add `vars: WORKSPACE_NAME: apitesting` (smoke owns its workspace — no env file dependency)
- [x] Both suites can be run independently from the same `local.env` with no changes between runs
- [x] All collection setup scripts updated to bridge pattern — `workspace-load` fixture, `workspace/`, `fs/`, `code/` collections all use `(ctx.vars.WORKSPACE_NAME as string) ?? ctx.env.WORKSPACE_NAME ?? ''`
- [x] `shotgun run --suite api-testapp-1` loads the `api-testapp-1` workspace
- [x] `shotgun run --suite smoke` loads `apitesting` — unchanged behavior
- [x] `get-list.yaml` updated — verifies both `apitesting` and `api-testapp-1` appear in the workspace list
- [x] `local.env` narrowed to infrastructure only — `WORKSPACE_NAME`, `FILE_PATH`, `CLASS_NAME`, etc. removed
- [x] `tsap.yaml` updated with `vars: WORKSPACE_NAME: api-testapp-1`

**Bridge pattern (used everywhere workspace is loaded from setup):**
```typescript
const wsName = ((ctx.vars.WORKSPACE_NAME as string) ?? ctx.env.WORKSPACE_NAME ?? '').trim();
```

**Notes:**
- Engine vars feature is **implemented** — suite `vars:` seed `ctx.vars` before any collection setup fires; collection `vars:` merge on top (collection wins on collision); runtime script assignments win over all YAML
- `local.env` is now infrastructure-only — no `WORKSPACE_NAME`, `FILE_PATH`, or test parameters
- The smoke suite stays exactly as-is in purpose — quick API health check using the stable `apitesting` fixture

---

### Story 0.2 — Anchor Real File Paths via Collection `vars:` Blocks ⏳ PENDING

**As a** test engineer,
**I want** collection `vars:` blocks populated with real target-app file paths,
**so that** path-param tests (code/structure, fs/file, deps/impact, etc.) run against the actual todo app without requiring env file changes.

**Acceptance Criteria:**
- [ ] `code/_collection.yaml` gains a `vars:` block with `FILE_PATH`, `CLASS_NAME`, `METHOD_NAME`, `PROPERTY_NAME` pointing to a real .cs file in the todo API backend
- [ ] `fs/_collection.yaml` gains a `vars:` block with `FILE_PATH` and `DIR_PATH`
- [ ] `deps/_collection.yaml` gains a `vars:` block with `FILE_PATH` pointing to a file with known dependencies
- [ ] A TypeScript frontend file (`TS_FILE_PATH`) and a Svelte component file (`SVELTE_FILE_PATH`) are identified and added as `vars:` in collections that test multi-language analysis
- [ ] All path values are discovered first via `GET /api/fs/list/src` and `GET /api/code/files` before being committed to collection YAML
- [ ] Collection `vars:` blocks do **not** duplicate `WORKSPACE_NAME` (that lives in suite `vars:`)

**Example `code/_collection.yaml` after this story:**
```yaml
name: Code / AST API
vars:
  FILE_PATH: src/TinyAST.Api/Endpoints/WorkspaceBackupEndpoints.cs
  CLASS_NAME: WorkspaceBackupEndpoints
  METHOD_NAME: CreateBackup
  PROPERTY_NAME: Name
  DIR_PATH: src
```

**Notes:**
- Collect paths using `shotgun run --suite api-testapp-1 --collection fs` first, which will list root-level dirs
- The todo app has at minimum: `.cs` (API endpoints, models), `.ts` (stores, services), `.svelte` (UI components)
- This story produces the concrete file path values that all Phase 2+ tests depend on
- **Prerequisite for Story 2.x** — must be done before Phase 2 collections are fully exercised

---

## Phase 1 — Workspace Backup/Restore Collection ⏳ IN PROGRESS

### Story 1.1 — Backup/Restore CRUD Collection ⏳

**As a** test engineer,
**I want** full CRUD coverage of the `/api/workspace/backup` endpoints,
**so that** I can verify the backup/restore system works correctly and use it as a test harness safety net.

**New API Endpoints:**

| Verb | Path | Name | Description |
|------|------|------|-------------|
| `POST` | `/api/workspace/backup` | `CreateWorkspaceBackup` | Archive project directory as a named backup |
| `GET` | `/api/workspace/backup` | `ListWorkspaceBackups` | List all available backups, newest first |
| `POST` | `/api/workspace/backup/{name}/restore` | `RestoreWorkspaceBackup` | Restore from named backup + reload |
| `DELETE` | `/api/workspace/backup/{name}` | `DeleteWorkspaceBackup` | Delete a named backup archive |

**Implementation:** See [`local-dev-test-repo/testing-plans/workspace-backup.md`](../../local-dev-test-repo/testing-plans/workspace-backup.md)

**Test files to create:**
```
local-dev-test-repo/tests/collections/workspace-backup/
  _collection.yaml
  post-backup-create.yaml
  get-backup-list.yaml
  post-backup-restore.yaml
  delete-backup.yaml
```

**Collection Execution Order:**
1. `post-backup-create` — creates `shotgun-backup-{timestamp}`, stashes name in `ctx.vars.backupName`
2. `get-backup-list` — lists backups, asserts `ctx.vars.backupName` appears in results
3. `post-backup-restore` — restores from `ctx.vars.backupName`, asserts 200
4. `delete-backup` — deletes `ctx.vars.backupName`, asserts 200/204

**Teardown Safety:** If `ctx.vars.backupName` is still set at teardown, attempt a DELETE (safety net against leftover test backups).

**Snapshot Policy:**
- `post-backup-create`: `snapshot: false` — response contains timestamps and generated paths
- `get-backup-list`: `snapshot: false` — list grows over time; use `shape:` assertions
- `post-backup-restore`: `snapshot: false` — response is a reload confirmation
- `delete-backup`: `snapshot: false` — 204 No Content or 200 with simple ack

**Acceptance Criteria:**
- [x] All 4 test files exist with correct structure
- [x] `_collection.yaml` defines order and teardown safety
- [ ] `post-backup-create` succeeds and stashes backup name  ← **needs live run**
- [ ] `get-backup-list` confirms the backup appears in the list  ← **needs live run**
- [ ] `post-backup-restore` confirms workspace reloads successfully  ← **needs live run**
- [ ] `delete-backup` removes the backup (verify with second GET list in post: script)  ← **needs live run**
- [x] `get-backup-list.yaml` tagged `smoke` — a quick "does backup system exist?" check
- [x] Suite `tsap.yaml` updated to include `workspace-backup` collection

---

### Story 1.2 — Backup as Test Harness Pattern

**As a** test engineer,  
**I want** a shared fixture pattern that uses backup before destructive operations,  
**so that** write and agent tests can always restore the workspace to a known-good state.

**The Pattern (for Phase 3+ tests):**

```javascript
// In collection setup — before destructive tests:
const backupName = `shotgun-pre-test-${Date.now()}`;
const res = await ctx.http.post('/api/workspace/backup', { name: backupName });
ctx.assert(res.status === 200 || res.status === 201, `Backup create failed: ${res.status}`);
ctx.vars.preTestBackup = backupName;
ctx.log(`Pre-test backup created: "${backupName}"`);
```

```javascript
// In collection teardown — after destructive tests:
if (ctx.vars.preTestBackup) {
  const res = await ctx.http.post(`/api/workspace/backup/${ctx.vars.preTestBackup}/restore`, null);
  ctx.log(`Backup restored: ${res.status}`);
  const del = await ctx.http.delete(`/api/workspace/backup/${ctx.vars.preTestBackup}`);
  ctx.log(`Pre-test backup deleted: ${del.status}`);
}
```

**Acceptance Criteria:**
- [ ] Pattern documented in [`local-dev-test-repo/testing-plans/workspace-backup.md`](../../local-dev-test-repo/testing-plans/workspace-backup.md)
- [ ] Any collection that makes write operations adopts this pattern in `_collection.yaml`
- [ ] The pattern is used in Phase 3 (write) and Phase 5 (agent) collections

---

## Phase 2 — Read Primitives Against Real App

### Story 2.1 — File System Exploration Tests

**As a** test engineer,  
**I want** fs collection tests to run against real todo-app paths,  
**so that** I prove Enigma can enumerate, read, and verify files in a real project.

**Targets in fs collection (already implemented — needs env var population):**
- `GET /api/fs/list/{dirPath}` — explore `src/`, `src/TinyAST.Api/`, frontend dirs
- `GET /api/fs/exists/{path}` — check existence of known files (e.g., `src/TinyAST.Api/Endpoints/WorkspaceBackupEndpoints.cs`)
- `GET /api/fs/file/{filePath}` — read a real .cs file content
- `GET /api/fs/verify/{filePath}` — verify a known file's hash/integrity

**Acceptance Criteria:**
- [ ] `FILE_PATH` in `local.env` points to a real file in `api-testapp-1`
- [ ] `DIR_PATH` in `local.env` points to `src/` or root
- [ ] `shotgun run --collection fs` passes with 0 failures
- [ ] Snapshots captured for list and exists endpoints

---

### Story 2.2 — Code AST Analysis Tests

**As a** test engineer,  
**I want** the code collection to run against real todo-app files,  
**so that** I prove Enigma's AST indexing and analysis work on a real multi-language project.

**Key path-param tests to unlock:**
- `GET /api/code/structure/{filePath}` — structural breakdown of a .cs file
- `GET /api/code/node/{filePath}` — AST node for a .cs file  
- `GET /api/code/class/{className}/{filePath}` — class detail for a known todo class
- `GET /api/code/method/{className}/{methodName}/{filePath}` — specific method detail
- `GET /api/code/property/{className}/{propertyName}/{filePath}` — property detail
- `GET /api/code/raw/{filePath}` — raw source retrieval

**Multi-language targets (the interesting part):**
- `.cs` backend endpoint/controller files
- `.ts` frontend service/store files
- `.svelte` component files (Enigma must handle Svelte as a file type)

**Env vars to populate:**
```
FILE_PATH=src/TinyAST.Api/Endpoints/<SomeEndpointFile.cs>
CLASS_NAME=<ClassName in that file>
METHOD_NAME=<MethodName in that class>
PROPERTY_NAME=<PropertyName on that class>
```

**Acceptance Criteria:**
- [ ] `shotgun run --collection code` passes with 0 failures
- [ ] Structure endpoint returns parseable AST for the .cs file
- [ ] Class endpoint returns the correct class shape
- [ ] Method endpoint returns method signature and body
- [ ] Index languages endpoint confirms `.cs`, `.ts`, `.svelte` (or `.js`) in index
- [ ] Snapshots captured for all stable GET endpoints

---

### Story 2.3 — Dependency Analysis Tests

**As a** test engineer,  
**I want** the deps collection to run against real todo-app file paths,  
**so that** I prove Enigma understands the import/dependency graph of a real project.

**Key endpoints:**
- `GET /api/deps/files/{filePath}` — dependencies of a known file
- `GET /api/deps/impact/{filePath}` — what files depend on this file
- `GET /api/deps/methods/{filePath}` — method-level dependency data
- `GET /api/deps/order/{filePath}` — processing order for a file
- `GET /api/deps/hotspots` — files with most incoming dependencies (should be interesting on a real app)

**Interesting answer we want:** Does Enigma correctly identify that the Svelte frontend depends on the TypeScript services, which call the .NET API? Cross-language dep graph.

**Acceptance Criteria:**
- [ ] `shotgun run --collection deps` passes with 0 failures
- [ ] `deps/impact` returns non-empty results for a file that other files import
- [ ] `deps/hotspots` returns meaningful data (real apps have real hotspots)

---

## Phase 3 — Write Primitives

### Story 3.1 — File System Write Tests

**As a** test engineer,  
**I want** to exercise `PUT /api/fs/file/{filePath}` and related write endpoints,  
**so that** I prove Enigma can write files into the workspace.

**Pattern:**  
`backup → read file → modify content → PUT write → verify with GET → restore`

**New collection: `fs-write`**

| Verb | Path | Test File |
|------|------|-----------|
| `GET` /api/fs/file/{filePath} | Read baseline | `get-file-baseline.yaml` |
| `PUT` /api/fs/file/{filePath} | Write modified content | `put-file-write.yaml` |
| `GET` /api/fs/file/{filePath} | Confirm write | `get-file-confirm-write.yaml` |
| `DELETE` /api/fs/file/{filePath} | *Skipped — use restore* | — |

**Teardown:** Restore from pre-test backup (Story 1.2 pattern).

**Acceptance Criteria:**
- [ ] `put-file-write.yaml` writes a small, non-breaking change (e.g., append a comment to end of file)
- [ ] `get-file-confirm-write.yaml` asserts the change is present in the file content
- [ ] Teardown restores workspace to pre-test state
- [ ] Verify restore worked by re-reading the file and asserting original content

---

### Story 3.2 — Code Edit Tests (`POST /api/code/edit`)

**As a** test engineer,  
**I want** to exercise the code edit endpoint against a real class,  
**so that** I prove Enigma can programmatically modify source code via its edit API.

**Pattern:**  
`backup → GET class (baseline) → POST /api/code/edit → GET structure (verify) → restore`

**Edits to test:**
- Add a simple XML doc comment to an existing method
- Rename a local variable within a method body
- (Stretch) Add a new method to an existing class

**New collection: `code-edit`**

| Test File | Operation |
|-----------|-----------|
| `post-edit-add-comment.yaml` | `POST /api/code/edit` — add doc comment |
| `get-structure-verify-edit.yaml` | Confirm edit via structure endpoint |
| `post-edit-rollback.yaml` | `POST /api/code/compile/rollback` or restore from backup |

**Acceptance Criteria:**
- [ ] `post-edit-add-comment.yaml` succeeds (200)
- [ ] Structure GET after edit shows the comment in the AST
- [ ] Workspace is restored to original state in teardown

---

### Story 3.3 — Checkpoint Lifecycle Tests

**As a** test engineer,  
**I want** to use `POST /api/code/checkpoints` + `POST /api/code/checkpoints/{id}/rollback`,  
**so that** I prove the built-in checkpoint system works as a secondary safety net.

**This extends existing `code` collection.** The `post-checkpoint` and `delete-checkpoint` tests exist already — extend them for rollback:

- `post-checkpoint.yaml` — create pre-edit checkpoint (already exists)
- (Edit something via fs or code/edit)
- `post-rollback.yaml` — `POST /api/code/checkpoints/{checkpointId}/rollback`
- `get-structure-post-rollback.yaml` — confirm rollback restored original state

**Acceptance Criteria:**
- [ ] Rollback returns the file to pre-checkpoint state
- [ ] Structure endpoint confirms the rolled-back AST matches the original

---

## Phase 4 — Search & Semantic

### Story 4.1 — Full-Text and Semantic Search Tests

**As a** test engineer,  
**I want** to exercise FTS and semantic search against real todo-app code,  
**so that** I prove Enigma's search indexes work on real multi-language content.

**Endpoints:**
- `POST /api/code/search/fts` — full-text search (keyword in real code)
- `POST /api/code/search/class` — find class by name
- `POST /api/code/search/method` — find method by name
- `POST /api/code/search/identifier` — find identifier
- `POST /api/code/search/literal` — find string literal
- `POST /api/code/search/invocation` — find call sites
- `POST /api/code/search/semantic` — semantic search (embedding-based)
- `POST /api/code/search/hybrid` — combined FTS + semantic

**Search queries to use (real todo app terms):**
- FTS: `"todo"`, `"TodoItem"`, `"complete"`, `"create"`
- Semantic: `"mark a todo item as done"`, `"get all incomplete tasks"`
- Class search: the primary TodoItem class name
- Literal search: any real string constant visible in the source

**Acceptance Criteria:**
- [ ] FTS returns at least one result for `"todo"` (it's a todo app!)
- [ ] Semantic search returns relevant code for a natural language query
- [ ] Hybrid search returns results with both score types
- [ ] `POST /api/code/search/reindex` can be triggered and returns 200

---

### Story 4.2 — Clone Detection Against Real App

**As a** test engineer,  
**I want** to run clone detection against the todo app,  
**so that** I prove Enigma's clone analysis finds real duplicate patterns in real code.

**Endpoints:**
- `GET /api/code/clones/status` (already in code collection)
- `GET /api/code/clones/groups` (already in code collection)
- `GET /api/code/clones/report` (already in code collection)
- `GET /api/code/clones/find/{filePath}` (needs FILE_PATH — already in code collection)

**What we expect on a real app:** A real todo app will have CRUD pattern repetition — create/read/update/delete following similar shapes. Enigma's clone detection should identify these patterns.

**Acceptance Criteria:**
- [ ] Clone groups returns non-empty results (real code has clones)
- [ ] Clone report provides actionable summary data
- [ ] Clone find for a specific file returns its clone relationships

---

## Phase 5 — Agent-Driven End-to-End (The Big Vision)

### Story 5.1 — Agent E2E: Instruction → Edit → Verify → Restore

**As a** test engineer,  
**I want** to send a real instruction to an Enigma agent and verify that agent makes a real, verifiable code change,  
**so that** I prove the full Enigma intelligence loop works end-to-end.

**The Flow:**

```
1. [setup]     POST /api/workspace/backup   → create safety-net backup
2. [test 1]    POST /api/agents/{name}/actions/start  → create agent session
3. [test 2]    POST /api/agents/{name}/actions/send   → send instruction
               Instruction: "Add a GetAllCompleted method to the TodoItem controller
                             that returns only completed todo items."
4. [test 3]    GET  /api/agents/{name}/output         → poll for completion
               Assert: agent output confirms the edit was made
5. [test 4]    GET  /api/diff                         → confirm diff exists
               Assert: diff for the target file is non-empty
6. [test 5]    GET  /api/code/method/{class}/{method}/{file}
               Assert: GetAllCompleted method now exists in the AST
7. [test 6]    POST /api/code/checkpoints/{id}/rollback  OR
               POST /api/workspace/backup/{name}/restore → clean state
```

**New collection: `agent-e2e`**

| Test File | Operation |
|-----------|-----------|
| `post-agent-start.yaml` | Start agent session |
| `post-agent-send-instruction.yaml` | Send code edit instruction |
| `get-agent-output-poll.yaml` | Poll for completion |
| `get-diff-verify-change.yaml` | Confirm diff shows the change |
| `get-code-method-verify.yaml` | Confirm AST reflects new method |
| `post-workspace-restore.yaml` | Restore from pre-test backup |

**Prerequisites:**
- An agent must be configured and running (`ctx.env.AGENT_NAME`)
- Phase 3 write primitives must be proven (we need confidence edits work before agents try them)
- Backup/restore must be proven stable (Phase 1)

**Acceptance Criteria:**
- [ ] Agent receives instruction and acknowledges it
- [ ] Agent output contains confirmation of the edit
- [ ] Diff endpoint shows a non-empty diff for the target file
- [ ] Code/method endpoint confirms the new method exists in the AST
- [ ] Workspace is restored to pre-agent state after test
- [ ] Run is idempotent — can be run again on a restored workspace

---

### Story 5.2 — Agent E2E: Svelte Component Generation

**As a** test engineer,  
**I want** to send an instruction to generate a new Svelte component,  
**so that** I prove Enigma agents can work across language boundaries.

**Instruction example:**  
_"Create a new Svelte component `CompletedTodos.svelte` that displays only completed todo items using the existing todo store."_

**Verify:**
- `GET /api/fs/exists/{path}` — new file exists
- `GET /api/fs/file/{path}` — content is valid Svelte
- `GET /api/code/structure/{filePath}` — Enigma indexed the new file

**Acceptance Criteria:**
- [ ] Agent creates the new file
- [ ] File content is syntactically valid Svelte (can be asserted with a regex shape check on `<script>` and `<html>` blocks)
- [ ] Enigma indexes the file after creation (may require reindex trigger)
- [ ] Restore removes the file and returns workspace to clean state

---

## Suite Definitions

### Updated `smoke.yaml` — owns `apitesting` via `vars:`
Fast, read-only, no mutations. The smoke suite **stays targeting `apitesting`** — it is the quick API health check, not a deep-dive on the todo app. It just now owns its workspace name declaratively:
```yaml
name: Smoke Suite
vars:
  WORKSPACE_NAME: apitesting   # smoke always hits the stable synthetic fixture
collections:
  - system
  - workspace
  - code
  - fs
  - graph
tags:
  - smoke
```

### New `api-testapp-1.yaml` Suite — owns `api-testapp-1` via `vars:`
Full coverage pass against the real todo app — all phases:
```yaml
name: api-testapp-1 Full Test Pass
vars:
  WORKSPACE_NAME: api-testapp-1
  AGENT_NAME: ""               # set to your agent name for Phase 5 tests
collections:
  - system
  - workspace
  - workspace-backup
  - fs
  - code
  - deps
  - fs-write        # Phase 3
  - code-edit       # Phase 3
  - search          # Phase 4 (or integrated into code collection)
  - agent-e2e       # Phase 5 — requires AGENT_NAME set in suite vars or local.env
```

### Updated `tsap.yaml` — Tests that Should Always Pass
```yaml
name: TSAP — Tests that Should Always Pass
vars:
  WORKSPACE_NAME: api-testapp-1   # TSAP now validates against the real app
collections:
  - system
  - workspace
  - workspace-backup
  - code
  - fs
  - graph
```

---

## Environment Variable Schema (Infrastructure Only)

With the `vars:` engine feature, `local.env` is **infrastructure only** — it tells shotgun *where* to connect, not *what* to test. Test parameters live in suite and collection YAML.

```bash
# local-dev-test-repo/envs/local.env
#
# INFRASTRUCTURE ONLY — where is the server, what are the credentials.
# Test parameters (workspace name, file paths, class names) belong in
# suite vars: and collection vars: blocks — NOT in this file.
#
# ── Core ─────────────────────────────────────────────────────────────────────
BASE_URL=http://m1x.local:3080
TIMEOUT=15
LOG_LEVEL=debug

# ── Auth (bearer token — no "Bearer " prefix needed) ─────────────────────────
AUTH_TOKEN=
```

**Test parameters live here instead:**

| Parameter | Defined in |
|-----------|-----------|
| `WORKSPACE_NAME` | `suite.yaml vars:` (`apitesting` for smoke, `api-testapp-1` for deep tests) |
| `AGENT_NAME` | `suite.yaml vars:` or per-collection `vars:` |
| `FILE_PATH` | `code/_collection.yaml vars:`, `fs/_collection.yaml vars:`, etc. |
| `CLASS_NAME` | `code/_collection.yaml vars:` |
| `METHOD_NAME` | `code/_collection.yaml vars:` |
| `PROPERTY_NAME` | `code/_collection.yaml vars:` |
| `DIR_PATH` | `fs/_collection.yaml vars:` |
| `TS_FILE_PATH` | language-specific collection `vars:` |
| `SVELTE_FILE_PATH` | language-specific collection `vars:` |

> **Backward compat:** Scripts that currently read `ctx.env.FILE_PATH` continue to work. The `vars:` block populates `ctx.vars.FILE_PATH` — scripts should use `(ctx.vars.FILE_PATH ?? ctx.env.FILE_PATH ?? '').trim()` as the bridge pattern during migration.

---

## Implementation Order

```
Sprint 0 ── Engine Prerequisites  ✅ DONE
  [x]  Implement vars: on CollectionDefinition (suite-collection-vars.md Story 1)
  [x]  Implement vars: on SuiteDefinition     (suite-collection-vars.md Story 2)
  [x]  Narrow local.env to infrastructure only

Sprint 1 ── Pivot + Safety Net  ⏳ IN PROGRESS
  [x]  Create api-testapp-1.yaml suite with vars: WORKSPACE_NAME: api-testapp-1
  [x]  Update smoke.yaml with vars: WORKSPACE_NAME: apitesting
  [x]  Update tsap.yaml with vars: WORKSPACE_NAME: api-testapp-1
  [x]  Apply bridge pattern to workspace-load fixture and all collection setups
  [x]  Update workspace/get-list.yaml — asserts both workspaces in list
  [x]  Build workspace-backup collection (4 tests: create/list/restore/delete)
  [x]  Backup-as-harness pattern documented in workspace-backup.md
  [ ]  Live run: shotgun run --suite api-testapp-1 --collection workspace-backup
  [ ]  0.2  Discover real file paths via fs/list + code/files → add to collection vars:

Sprint 2 ── Read Primitives
  2.1  fs collection — vars: populated, run with real paths, capture snapshots
  2.2  code collection — vars: populated, run with real paths, capture snapshots
  2.3  deps collection — vars: populated, run with real paths

Sprint 3 ── Write Primitives
  3.1  fs-write collection (backup → write → verify → restore)
  3.2  code-edit collection (backup → edit → AST verify → restore)
  3.3  checkpoint rollback tests

Sprint 4 ── Search & Semantic
  4.1  Search posts (FTS, semantic, hybrid, class, method) against real app
  4.2  Clone detection analysis — expect CRUD pattern clones in a real todo app

Sprint 5 ── Agent E2E
  5.1  Agent instruction → .cs edit → verify → restore
  5.2  Agent instruction → .svelte generation → verify → restore
```

---

## Key Insights & Design Decisions

### Why `api-testapp-1` is better than `apitesting`

| Dimension | `apitesting` | `api-testapp-1` |
|-----------|-------------|----------------|
| App type | Synthetic / purpose-built for Enigma | Real production-pattern todo app |
| Languages | Likely mono-language | TypeScript + Svelte + C#/.NET |
| Code patterns | Engineered for testing | Natural CRUD patterns, real clones |
| Semantic richness | Limited | Full domain model (TodoItem, User, etc.) |
| Agent test value | Low | High — real structure to navigate and edit |

### Backup/Restore as the Master Pattern

Every potentially destructive collection **must** follow:
```
setup: backup → tests: mutate → teardown: restore
```
This makes the full TSAP run idempotent. You can run it 100 times and the workspace ends in the same state it started.

### `vars:` Is the Foundation of Multi-Workspace Testing

The reason smoke (`apitesting`) and deep tests (`api-testapp-1`) can coexist without env file juggling:

| Suite | `vars: WORKSPACE_NAME` | Who uses it |
|-------|------------------------|-------------|
| `smoke.yaml` | `apitesting` | Quick API health check — stable synthetic fixture |
| `api-testapp-1.yaml` | `api-testapp-1` | Deep analysis — real TypeScript/Svelte/.NET app |
| `tsap.yaml` | `api-testapp-1` | Full regression — now against the real app |

`.env` files carry **where** (server, creds). Suite `vars:` carry **what workspace**. Collection `vars:` carry **what files**. Scripts carry **what IDs were computed at runtime**. Each layer owns its own concern.

### The Agent Test Is the Goal

Everything in Phases 0–4 is infrastructure for Phase 5. The goal is:
> "Shotgun sends a natural language instruction to an Enigma agent. The agent modifies real code. Shotgun verifies the modification using Enigma's own analysis APIs. Shotgun restores the workspace. Repeat."

This is the world's most honest test of an AI coding assistant: it runs, the code changes, the AST confirms it, we know it worked.
