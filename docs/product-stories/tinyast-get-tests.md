# Enigma (formerly TinyAST) GET Test Suite — Plan

> Status: In progress — system collection complete ✅
> Target dev URL: `http://m1x.local:3080`
> Spec (latest): [`local-dev-test-repo/specs/enigma-api.json`](../../local-dev-test-repo/specs/enigma-api.json)
> Summary: [`local-dev-test-repo/specs/enigma-api-summary.txt`](../../local-dev-test-repo/specs/enigma-api-summary.txt)

> **Note:** The API is being renamed from TinyAST → Enigma. The two names refer to the same API.
> All new test artifacts use the Enigma name in comments/descriptions; the endpoints are unchanged.

---

## Spec Delta (v2 — Enigma)

The following GET endpoints are **new** in the Enigma spec vs the original TinyAST spec:

| New Endpoint | Collection | Notes |
|---|---|---|
| `GET /api/agents/catalog` | agents | List agent catalog definitions |
| `GET /api/agents/catalog/{name}` | agents | Get a specific catalog entry by name |
| `GET /api/deps/order/{filePath}` | deps | Dependency processing order for a file |
| `GET /api/workspace/current` | workspace | Get the currently loaded workspace |
| `GET /api/workspace/list` | workspace | List all available workspaces |

**Also refined from system collection testing:**
- Scripts now use `ctx.assert(...)` instead of bare `assert(...)` — apply consistently to all new tests.

---

## Overview

Build a complete banger test suite covering every GET endpoint in the Enigma API spec.
Total: **112 GET endpoints** across **14 collections**, organized under `local-dev-test-repo/`.

Auth is currently not required by the API but will be bearer token in the future. The auth
plumbing is wired now (env var + header injection) so no rework is needed when auth is turned on.

---

## Collection Breakdown

| Collection | Dir | # Tests | Status | Notes |
|------------|-----|---------|--------|-------|
| system | `tests/collections/system/` | 4 | ✅ Done | No params — smoke targets |
| workspace | `tests/collections/workspace/` | 9 | 🔜 Next | 2 new endpoints added |
| agents | `tests/collections/agents/` | 10 | ⬜ | 2 new catalog endpoints added |
| build | `tests/collections/build/` | 4 | ⬜ | SessionId chained from list |
| code | `tests/collections/code/` | 27 | ⬜ | Needs `FILE_PATH`, `CLASS_NAME`, etc. |
| comms | `tests/collections/comms/` | 7 | ⬜ | ChannelId chained from list |
| db | `tests/collections/db/` | 3 | ⬜ | Needs `DB_SCHEMA`, `DB_OBJECT_NAME` |
| deps | `tests/collections/deps/` | 9 | ⬜ | 1 new endpoint; needs `FILE_PATH` |
| diff | `tests/collections/diff/` | 3 | ⬜ | `FILE_PATH` for diff-by-file |
| fs | `tests/collections/fs/` | 4 | ⬜ | Needs `FILE_PATH`, `DIR_PATH` |
| graph | `tests/collections/graph/` | 4 | ⬜ | NodePath/LinkId chained from list |
| merge | `tests/collections/merge/` | 12 | ⬜ | MergeObjectId chained; needs `PROC_NAME` |
| sensors | `tests/collections/sensors/` | 4 | ⬜ | SensorName chained from list |
| vc | `tests/collections/vc/` | 11 | ⬜ | Heavy env vars: workspace/checkpoint/task IDs |

**Total: 112 test files**

---

## Endpoint → Test Mapping

### system (4)
| Endpoint | Test File | Smoke? |
|----------|-----------|--------|
| GET /api/system/health | `get-health.yaml` | ✅ |
| GET /api/system/version | `get-version.yaml` | ✅ |
| GET /api/system/feed | `get-feed.yaml` | — |
| GET /v1/models | `get-models.yaml` | ✅ |

> Note: `GET /api/system/mock/stream` is an SSE endpoint — excluded from GET suite, needs dedicated streaming test.

### workspace (9) — Next batch
| Endpoint | Test File | Smoke? | Notes |
|----------|-----------|--------|-------|
| GET /api/workspace/status | `get-status.yaml` | ✅ | |
| GET /api/workspace/meta | `get-meta.yaml` | ✅ | |
| GET /api/workspace/outline | `get-outline.yaml` | ✅ | |
| GET /api/workspace/current | `get-current.yaml` | ✅ | NEW in Enigma spec |
| GET /api/workspace/list | `get-list.yaml` | ✅ | NEW in Enigma spec |
| GET /api/workspace/memory | `get-memory.yaml` | — | |
| GET /api/workspace/memory/pressure | `get-memory-pressure.yaml` | — | |
| GET /api/workspace/order | `get-order.yaml` | — | |
| GET /api/workspace/order/next | `get-order-next.yaml` | — | |

### agents (10) — includes 2 new Enigma endpoints
| Endpoint | Test File | Path Param Strategy | Notes |
|----------|-----------|---------------------|-------|
| GET /api/agents | `get-agents.yaml` | none | stashes first name into `ctx.vars` |
| GET /api/agents/catalog | `get-agents-catalog.yaml` | none | NEW in Enigma |
| GET /api/agents/catalog/{name} | `get-agents-catalog-entry.yaml` | chained from catalog list OR `CATALOG_AGENT_NAME` env | NEW in Enigma |
| GET /api/agents/{name} | `get-agent-by-name.yaml` | `ctx.vars.agentName` or `AGENT_NAME` env | |
| GET /api/agents/{name}/config | `get-agent-config.yaml` | same | |
| GET /api/agents/{name}/info | `get-agent-info.yaml` | same | |
| GET /api/agents/{name}/logs | `get-agent-logs.yaml` | same | stashes first logName |
| GET /api/agents/{name}/logs/{logName} | `get-agent-log-by-name.yaml` | chained from logs list | |
| GET /api/agents/{name}/output | `get-agent-output.yaml` | same agent name | |
| GET /api/agents/{name}/stream | `get-agent-stream.yaml` | same agent name | SSE — expect 200, assert agent name is set |

### build (4)
| Endpoint | Test File | Path Param Strategy |
|----------|-----------|---------------------|
| GET /api/build/projects | `get-build-projects.yaml` | none |
| GET /api/build/sessions | `get-build-sessions.yaml` | none (stashes first sessionId) |
| GET /api/build/sessions/{sessionId} | `get-build-session.yaml` | chained from sessions list |
| GET /api/build/sessions/{sessionId}/diagnostics | `get-build-diagnostics.yaml` | chained from sessions list |

### code (27)
Parameterless:
- `get-checkpoints.yaml` — GET /api/code/checkpoints
- `get-files.yaml` — GET /api/code/files
- `get-index-status.yaml` — GET /api/code/index/status
- `get-index-languages.yaml` — GET /api/code/index/languages
- `get-index-deps.yaml` — GET /api/code/index/deps
- `get-index-errors.yaml` — GET /api/code/index/errors
- `get-index-references.yaml` — GET /api/code/index/references
- `get-index-store.yaml` — GET /api/code/index/store
- `get-index-symbols.yaml` — GET /api/code/index/symbols
- `get-js-http-calls.yaml` — GET /api/code/js/http-calls
- `get-notes.yaml` — GET /api/code/notes
- `get-patterns-list.yaml` — GET /api/code/patterns/list
- `get-razor-action-calls.yaml` — GET /api/code/razor/action-calls
- `get-search-sql.yaml` — GET /api/code/search/sql
- `get-search-status.yaml` — GET /api/code/search/status
- `get-clones-status.yaml` — GET /api/code/clones/status
- `get-clones-groups.yaml` — GET /api/code/clones/groups
- `get-clones-report.yaml` — GET /api/code/clones/report

Needs `FILE_PATH`:
- `get-clones-find-file.yaml` — GET /api/code/clones/find/{filePath}
- `get-structure.yaml` — GET /api/code/structure/{filePath}
- `get-raw-file.yaml` — GET /api/code/raw/{filePath}
- `get-node.yaml` — GET /api/code/node/{filePath}

Needs `CLASS_NAME` + `FILE_PATH`:
- `get-class.yaml` — GET /api/code/class/{className}/{filePath}
- `get-comments.yaml` — GET /api/code/comments/{className}/{filePath}

Needs `CLASS_NAME` + `METHOD_NAME` + `FILE_PATH`:
- `get-method.yaml` — GET /api/code/method/{className}/{methodName}/{filePath}

Needs `CLASS_NAME` + `PROPERTY_NAME` + `FILE_PATH`:
- `get-property.yaml` — GET /api/code/property/{className}/{propertyName}/{filePath}

Needs `ENCODED_KEY` (chained from notes list):
- `get-note-by-key.yaml` — GET /api/code/notes/{encodedKey}

### comms (7)
| Endpoint | Test File | Path Param Strategy |
|----------|-----------|---------------------|
| GET /api/comms/channels | `get-channels.yaml` | none (stashes first channelId) |
| GET /api/comms/channels/{id}/accounts | `get-channel-accounts.yaml` | chained |
| GET /api/comms/channels/{id}/status | `get-channel-status.yaml` | chained |
| GET /api/comms/channels/{id}/status/{accountId} | `get-channel-account-status.yaml` | chained from accounts list |
| GET /api/comms/pairing/codes | `get-pairing-codes.yaml` | none |
| GET /api/comms/pairing/devices | `get-pairing-devices.yaml` | none |
| GET /api/comms/allowlist/{channelId} | `get-allowlist.yaml` | chained channelId |

### db (3)
| Endpoint | Test File | Path Param Strategy |
|----------|-----------|---------------------|
| GET /api/db/status | `get-db-status.yaml` | none |
| GET /api/db/objects | `get-db-objects.yaml` | none |
| GET /api/db/objects/{schema}/{name}/ddl | `get-db-object-ddl.yaml` | `DB_SCHEMA` + `DB_OBJECT_NAME` env vars |

### deps (9) — includes 1 new Enigma endpoint
| Endpoint | Test File | Path Param Strategy | Notes |
|----------|-----------|---------------------|-------|
| GET /api/deps/status | `get-status.yaml` | none | |
| GET /api/deps/hotspots | `get-hotspots.yaml` | none | |
| GET /api/deps/links | `get-links.yaml` | none — stashes first link id | |
| GET /api/deps/links/{id} | `get-link-by-id.yaml` | chained from links list | |
| GET /api/deps/links/file/{filePath} | `get-links-for-file.yaml` | `FILE_PATH` env var | |
| GET /api/deps/files/{filePath} | `get-files.yaml` | `FILE_PATH` env var | |
| GET /api/deps/impact/{filePath} | `get-impact.yaml` | `FILE_PATH` env var | |
| GET /api/deps/methods/{filePath} | `get-methods.yaml` | `FILE_PATH` env var | |
| GET /api/deps/order/{filePath} | `get-order.yaml` | `FILE_PATH` env var | NEW in Enigma |

### diff (3)
| Endpoint | Test File | Path Param Strategy |
|----------|-----------|---------------------|
| GET /api/diff | `get-diffs.yaml` | none |
| GET /api/diff/analysis | `get-diff-analysis.yaml` | none |
| GET /api/diff/{filePath} | `get-diff-for-file.yaml` | `FILE_PATH` env var |

### fs (4)
| Endpoint | Test File | Path Param Strategy |
|----------|-----------|---------------------|
| GET /api/fs/exists/{path} | `get-fs-exists.yaml` | `FILE_PATH` env var |
| GET /api/fs/file/{filePath} | `get-fs-file.yaml` | `FILE_PATH` env var |
| GET /api/fs/list/{dirPath} | `get-fs-list.yaml` | `DIR_PATH` env var (default: `.`) |
| GET /api/fs/verify/{filePath} | `get-fs-verify.yaml` | `FILE_PATH` env var |

### graph (4)
| Endpoint | Test File | Path Param Strategy |
|----------|-----------|---------------------|
| GET /api/graph/nodes | `get-graph-nodes.yaml` | none (stashes first node path + link id) |
| GET /api/graph/nodes/{path} | `get-graph-node.yaml` | chained |
| GET /api/graph/links | `get-graph-links.yaml` | none |
| GET /api/graph/links/{id} | `get-graph-link.yaml` | chained |

### merge (12)
Parameterless:
- `get-merge-stats.yaml` — GET /api/merge/stats
- `get-merge-objects.yaml` — GET /api/merge/objects (stashes first merge object id)
- `get-merge-order.yaml` — GET /api/merge/order
- `get-merge-order-next.yaml` — GET /api/merge/order/next
- `get-merge-order-source.yaml` — GET /api/merge/order/source
- `get-merge-order-sql.yaml` — GET /api/merge/order/sql
- `get-merge-sql-links.yaml` — GET /api/merge/sql-links
- `get-merge-sql-links-status.yaml` — GET /api/merge/sql-links/status
- `get-merge-sql-deps-status.yaml` — GET /api/merge/sql-deps/status

Chained / env var:
- `get-merge-object.yaml` — GET /api/merge/objects/{id} (chained from list)
- `get-merge-order-file.yaml` — GET /api/merge/order/file/{filePath} (`FILE_PATH`)
- `get-merge-sql-links-by-proc.yaml` — GET /api/merge/sql-links/by-proc/{procName} (`PROC_NAME`)

### sensors (4)
| Endpoint | Test File | Path Param Strategy |
|----------|-----------|---------------------|
| GET /api/sensors | `get-sensors.yaml` | none (stashes first sensor name) |
| GET /api/sensors/build/status | `get-sensors-build-status.yaml` | none |
| GET /api/sensors/{name} | `get-sensor-by-name.yaml` | chained from list |
| GET /api/sensors/{name}/output | `get-sensor-output.yaml` | chained from list |

### vc (11)
| Endpoint | Test File | Path Param Strategy |
|----------|-----------|---------------------|
| GET /api/vc/tasks | `get-vc-tasks.yaml` | none (stashes first taskId) |
| GET /api/vc/tasks/{taskId} | `get-vc-task.yaml` | chained |
| GET /api/vc/checkpoints/{checkpointId} | `get-vc-checkpoint.yaml` | `VC_CHECKPOINT_ID` env var |
| GET /api/vc/integrations/{integrationId} | `get-vc-integration.yaml` | `VC_INTEGRATION_ID` env var |
| GET /api/vc/submissions/{submissionId} | `get-vc-submission.yaml` | `VC_SUBMISSION_ID` env var |
| GET /api/vc/workspaces/{workspaceId} | `get-vc-workspace.yaml` | `VC_WORKSPACE_ID` env var |
| GET /api/vc/workspaces/{workspaceId}/changes | `get-vc-workspace-changes.yaml` | `VC_WORKSPACE_ID` |
| GET /api/vc/workspaces/{workspaceId}/checkpoints | `get-vc-workspace-checkpoints.yaml` | `VC_WORKSPACE_ID` |
| GET /api/vc/workspaces/{workspaceId}/conflicts | `get-vc-workspace-conflicts.yaml` | `VC_WORKSPACE_ID` |
| GET /api/vc/workspaces/{workspaceId}/diff | `get-vc-workspace-diff.yaml` | `VC_WORKSPACE_ID` |
| GET /api/vc/workspaces/{workspaceId}/impact | `get-vc-workspace-impact.yaml` | `VC_WORKSPACE_ID` |

---

## Environment Variable Schema

```
# local-dev-test-repo/envs/local.env

# ── Core ─────────────────────────────────────────────────────────────────────
BASE_URL=http://m1x.local:3080
TIMEOUT=15
LOG_LEVEL=debug

# ── Auth (currently unused, plumbed for future bearer token) ─────────────────
AUTH_TOKEN=
# When auth is enabled, set to the raw token (no "Bearer " prefix needed):
# AUTH_TOKEN=my-secret-token

# ── Agents ───────────────────────────────────────────────────────────────────
AGENT_NAME=
# Set to the name of a known/running agent if any exist, else leave blank.
# Tests that need an agent name will FAIL if blank and no chained value exists — set this var.

# ── Code / AST ───────────────────────────────────────────────────────────────
FILE_PATH=
# A relative path to a source file in the workspace (e.g. src/MyClass.cs)
# Required for: code structure, raw, node, class, method, property, clones/find,
#               deps/files, deps/impact, deps/methods, diff/{filePath}, fs/*

DIR_PATH=.
# A directory path for fs/list. Defaults to workspace root.

CLASS_NAME=
# A C# class name that exists in FILE_PATH (e.g. MyClass)

METHOD_NAME=
# A method name within CLASS_NAME (e.g. DoSomething)

PROPERTY_NAME=
# A property name within CLASS_NAME (e.g. Id)

# ── Database ─────────────────────────────────────────────────────────────────
DB_SCHEMA=dbo
DB_OBJECT_NAME=
# Schema + object name for GET /api/db/objects/{schema}/{name}/ddl

# ── Merge / SQL ──────────────────────────────────────────────────────────────
PROC_NAME=
# A stored procedure name for GET /api/merge/sql-links/by-proc/{procName}

# ── Version Control ──────────────────────────────────────────────────────────
VC_WORKSPACE_ID=
VC_CHECKPOINT_ID=
VC_SUBMISSION_ID=
VC_INTEGRATION_ID=
```

> **Note on blank vars:** Tests that require a path param check for a non-empty value
> in their `pre:` script. If the var is blank AND no chained value exists in `ctx.vars`,
> the test uses `ctx.assert` to fail with a clear message identifying the missing prerequisite.

---

## Auth Plumbing Design

The auth header is injected in each collection's `_collection.yaml` `setup` script:

```javascript
// In _collection.yaml setup — runs once before first test
const raw = ctx.env.AUTH_TOKEN;
if (raw && raw.trim() !== '') {
  const token = raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
  ctx.vars.authHeader = token;
  ctx.log(`Auth token loaded (${token.length} chars, redacted)`);
} else {
  ctx.vars.authHeader = null;
  ctx.log('No AUTH_TOKEN set — running unauthenticated');
}
```

Each test's `pre:` script then applies it:

```javascript
// In individual test pre: script
if (ctx.vars.authHeader) {
  ctx.request.headers['Authorization'] = ctx.vars.authHeader;
}
```

When the API starts requiring auth, you only need to set `AUTH_TOKEN` in `local.env`.
No test files need to change.

---

## Path-Param Chaining Pattern

For endpoints where the ID/name is discovered at runtime (not known in advance):

```javascript
// In list test (e.g. get-build-sessions.yaml) post: script:
const sessions = ctx.response.body;
if (Array.isArray(sessions) && sessions.length > 0) {
  ctx.vars.firstSessionId = sessions[0].id;
  ctx.log(`Stashed sessionId: ${ctx.vars.firstSessionId}`);
}

// In get-build-session.yaml pre: script:
const id = ctx.vars.firstSessionId || ctx.env.SESSION_ID;
ctx.assert(!!id, 'No sessionId available — run get-build-sessions first or set SESSION_ID in env');
ctx.request.path = `/api/build/sessions/${id}`;
```

---

## Missing Param Strategy

Tests that require a path param handle missing values explicitly:

| Scenario | Behavior |
|----------|----------|
| Param available (chained or env var) | Test runs normally |
| Param missing, list returned 0 results | `ctx.assert` FAILS with clear message — set the env var or fix the prerequisite |
| Param missing, no list endpoint before it | `ctx.assert` FAILS with clear message — set the env var |
| API returns 404 | Test FAILS (unexpected for a known ID) |
| API returns 200 | Test PASSES shape/snapshot checks |

---

## Snapshot Strategy

- `snapshot: true` on all tests
- On first run: tests marked `needs_baseline` — run `banger snapshot` to capture
- `ignore_fields` tuned per-test to strip volatile fields (timestamps, durations, etc.)
- Baseline files land in `local-dev-test-repo/expected/{collection}/`

---

## Special Cases

### SSE Endpoints (excluded from GET suite)
- `GET /api/agents/{name}/stream` — persistent SSE; not suitable for standard assertion
- `GET /api/system/mock/stream` — mock SSE; same reason
- These will be handled in a dedicated streaming test story

### Pagination
- Endpoints with `?limit`/`?offset` params: test uses small `limit=5` to keep responses fast
- `GET /api/build/sessions?limit=5` etc.

### Query-param-only endpoints
- Tests include the most common/interesting query params as examples
- Full parameter matrix testing is out of scope for this first pass

---

## Suite Definitions

### `smoke.yaml`
Fast, read-only, no path params needed:
- **system**: health, version, models
- **workspace**: status, meta, outline
- All tagged `smoke`

### `gets-all.yaml`
All 14 collections. Full GET coverage pass. Tests that require env vars will fail if those vars are not set — set them in `local.env` before running.

---

## File Structure

```
local-dev-test-repo/
├── banger.config.yaml
├── tinyast-openapi-spec.json        # (existing)
├── tinyast-endpoints.txt            # (existing)
├── envs/
│   ├── local.env                    # gitignored — fill in values
│   └── local.env.example            # committed — template
├── scripts/
│   └── auth.ts                      # shared auth helper
├── tests/
│   ├── collections/
│   │   ├── agents/         (8 tests)
│   │   ├── build/          (4 tests)
│   │   ├── code/           (27 tests)
│   │   ├── comms/          (7 tests)
│   │   ├── db/             (3 tests)
│   │   ├── deps/           (8 tests)
│   │   ├── diff/           (3 tests)
│   │   ├── fs/             (4 tests)
│   │   ├── graph/          (4 tests)
│   │   ├── merge/          (12 tests)
│   │   ├── sensors/        (4 tests)
│   │   ├── system/         (4 tests)
│   │   ├── vc/             (11 tests)
│   │   └── workspace/      (7 tests)
│   └── suites/
│       ├── smoke.yaml
│       └── gets-all.yaml
└── expected/
    └── (populated by banger snapshot)
```

---

## Implementation Order

1. **Config + env** — `banger.config.yaml`, `local.env.example`, `scripts/auth.ts`
2. **Smoke-friendly collections first** — `system`, `workspace` (no path params)
3. **Simple list collections** — `build`, `deps`, `diff`, `graph`, `merge`, `sensors`, `vc`
4. **Agents** (needs `AGENT_NAME` or live agent)
5. **Code** (largest, needs `FILE_PATH` etc.)
6. **Comms + db** (may return 500 if not configured)
7. **fs** (needs real file paths)
8. **Suites** — `smoke.yaml`, `gets-all.yaml`
