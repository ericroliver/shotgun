# Banger Testing Journal

> Tips, tricks, patterns, and hard-won lessons for writing banger tests.
> Add to this as you discover things — don't let the knowledge die in Slack or a terminal window.

---

## Table of Contents

1. [Auth Wiring](#1-auth-wiring)
2. [Variable Stashing (the create→read→delete chain)](#2-variable-stashing-the-createreaddelete-chain)
3. [Skip Patterns](#3-skip-patterns)
4. [Snapshot Policy](#4-snapshot-policy)
5. [Write Test Shape Assertions](#5-write-test-shape-assertions)
6. [Teardown as Safety Net](#6-teardown-as-safety-net)
7. [Test Data Uniqueness](#7-test-data-uniqueness)
8. [Workspace Loading](#8-workspace-loading)
9. [URL Path Encoding Gotcha](#9-url-path-encoding-gotcha)
10. [Status Code Surprises](#10-status-code-surprises)
11. [jq Shape Assertion Tips](#11-jq-shape-assertion-tips)
12. [Debugging Failed Runs](#12-debugging-failed-runs)
13. [Collection Order Matters](#13-collection-order-matters)
14. [ctx.http vs curl](#14-ctxhttp-vs-curl)
15. [Testing Plans as Living Docs](#15-testing-plans-as-living-docs)

---

## 1. Auth Wiring

**Never wire auth per-test.** Do it once in collection `setup` and stash the resolved header in `ctx.vars`:

```javascript
// _collection.yaml setup:
const raw = (ctx.env.AUTH_TOKEN ?? '').trim();
if (raw) {
  ctx.vars.authHeader = raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
  ctx.log(`Auth token loaded (${ctx.vars.authHeader.length} chars)`);
} else {
  ctx.vars.authHeader = null;
  ctx.log('AUTH_TOKEN not set — running unauthenticated');
}
```

Then in every test's `pre`:

```javascript
if (ctx.vars.authHeader) {
  ctx.request.headers['Authorization'] = ctx.vars.authHeader;
}
```

**Why:** If the token format changes (e.g. bare token vs. `Bearer` prefix), you fix it in one place.

**Why the null guard:** `ctx.http.*` calls inside setup/teardown also need the auth header. Build it once, use everywhere.

---

## 2. Variable Stashing (the create→read→delete chain)

CRUD test chains work by stashing created resource identifiers in `ctx.vars` and consuming them downstream.

### Pattern

```javascript
// post-script of CREATE test:
const body = ctx.response.body as any;
ctx.vars.createdNodePathA = body.path ?? ctx.vars.testNodePathA;
ctx.log(`Node A created — path: ${ctx.vars.createdNodePathA}`);

// pre-script of READ / DELETE test:
const path = ctx.vars.createdNodePathA as string;
if (!path) ctx.skip('No node path stashed — create test may have failed');
ctx.request.path = `/api/graph/nodes/${path}`;
```

### Important: initialize vars to null in setup

Always initialize your expected vars in `setup` so downstream tests don't accidentally consume stale values from a previous run:

```javascript
// _collection.yaml setup:
ctx.vars.createdNodePathA = null;
ctx.vars.createdNodePathB = null;
ctx.vars.createdLinkId    = null;
```

### Important: clear vars on successful delete

When a delete test succeeds, clear the var so teardown knows it doesn't need to clean up:

```javascript
// post-script of DELETE test:
ctx.assert(ctx.response.status === 200, `Expected 200 on delete, got ${ctx.response.status}`);
ctx.vars.createdNodePathA = null;  // ← prevents teardown from double-deleting
ctx.log('Node A deleted and var cleared');
```

---

## 3. Skip Patterns

Use `ctx.skip()` in `pre` when a test depends on a var that a previous test was supposed to set. This makes it clear the test is a no-op, not a failure.

```javascript
// pre-script:
const id = ctx.vars.createdLinkId as string;
if (!id) {
  ctx.skip('No link id stashed — create-graph-link may have failed or was skipped');
}
ctx.request.path = `/api/graph/links/${id}`;
```

**`ctx.skip()` never returns** — it throws internally and terminates the pre-script. No need for `return` after it (TypeScript will flag unreachable code if you try).

**Don't use skip for expected API behavior** (e.g. 405 on DELETE of a link). Skip is for "we can't even try because a prerequisite didn't run." Use `response.status` assertions for known API quirks.

---

## 4. Snapshot Policy

The rule is simple:

| Method | `snapshot` |
|--------|-----------|
| GET | `true` |
| POST / PUT / PATCH / DELETE | `false` |

**Why write tests don't snapshot:** Response bodies from write operations contain volatile data (IDs, timestamps, auto-generated paths). The snapshot would fail on every run.

**ignore_fields for GET snapshots:** Even read endpoints often include timestamps. Always check the actual response and strip the volatile fields:

```yaml
response:
  snapshot: true
  ignore_fields:
    - "**.createdAt"
    - "**.updatedAt"
    - "**.timestamp"
    - "**.requestId"
```

**When baseline doesn't exist yet:** The test is marked `needs_baseline` — not a failure. Run `banger snapshot` to capture it, commit the `expected/` file, then subsequent runs will diff against it.

---

## 5. Write Test Shape Assertions

Since write tests don't snapshot, shape assertions are your only structural verification. Make them meaningful:

```yaml
# Good — verifies the response has the expected fields
shape:
  - 'has("path")'
  - 'has("contentType")'
  - 'has("persist")'

# For create responses that may or may not return an id vs path:
shape:
  - '(has("path") or has("id"))'
  - '(has("type") or has("label") or has("contentType"))'
```

**Tip:** If you don't know the exact shape yet, probe the endpoint with curl first, inspect the response, then write assertions.

```bash
curl -s -X POST "${BASE_URL}/api/graph/nodes" \
  -H "Content-Type: application/json" \
  -d '{"path":"probe/test","contentType":"text/plain","content":"test","persist":"file"}' | jq .
```

---

## 6. Teardown as Safety Net

Teardown exists to clean up test data even if mid-suite tests fail. Write it defensively:

```javascript
// _collection.yaml teardown:
const headers = {};
if (ctx.vars.authHeader) headers['Authorization'] = ctx.vars.authHeader;

if (ctx.vars.createdNodePathA) {
  ctx.log(`Teardown: deleting node A "${ctx.vars.createdNodePathA}"`);
  try {
    const res = await ctx.http.delete(`/api/graph/nodes/${ctx.vars.createdNodePathA}`, { headers });
    ctx.log(`Node A delete response: ${res.status}`);
  } catch (err) {
    ctx.log(`Teardown node A delete failed (non-fatal): ${err.message}`);
  }
} else {
  ctx.log('No node A to clean up');
}
```

Key principles:
- Always wrap teardown HTTP calls in `try/catch` — teardown errors must not mask test failures
- Check `if (ctx.vars.X)` before attempting delete — if the var was cleared by a successful delete test, don't double-delete
- Log what teardown does so you can trace cleanup in run logs

---

## 7. Test Data Uniqueness

Any test data your suite creates should use a timestamp-based unique key. This prevents:
- Collisions between repeated runs (e.g., leftover data from a previous failed run)
- Collisions between parallel runs (e.g., CI running two environments simultaneously)

```javascript
// _collection.yaml setup:
const ts = Date.now();
ctx.vars.testNodePathA = `banger-test/node-a-${ts}`;
ctx.vars.testNodePathB = `banger-test/node-b-${ts}`;
```

**Namespace your test data.** Use a consistent prefix like `banger-test/` so you can identify and manually purge test data if needed.

---

## 8. Workspace Loading

For APIs that require a workspace context, load it in collection `setup` — not per-test:

```javascript
// _collection.yaml setup:
const wsName = (ctx.env.WORKSPACE_NAME ?? '').trim();
if (wsName) {
  const headers = { 'Content-Type': 'application/json' };
  if (ctx.vars.authHeader) headers['Authorization'] = ctx.vars.authHeader;
  const res = await ctx.http.post(`/api/workspace/load/${wsName}`, null, { headers });
  if (res.status === 200) {
    ctx.log(`Workspace "${wsName}" loaded successfully`);
  } else {
    ctx.log(`WARNING: Workspace load returned ${res.status} — data may not resolve correctly`);
  }
  ctx.vars.workspaceName = wsName;
}
```

**Why `null` body for POST with no body:** `ctx.http.post(path, null, opts)` — pass `null` as the body if the endpoint takes no request body. Passing `{}` may cause issues on some APIs.

---

## 9. URL Path Encoding Gotcha

### Don't encode path separators

If the API uses real path segments as resource identifiers (e.g., `banger-test/node-a-123`), do **not** `encodeURIComponent` the full thing — that would encode the `/` and break the route:

```javascript
// ✅ Correct — real slashes preserved
ctx.request.path = `/api/graph/nodes/${ctx.vars.createdNodePathA}`;

// ❌ Wrong — encodes '/' as '%2F', API returns 404
ctx.request.path = `/api/graph/nodes/${encodeURIComponent(ctx.vars.createdNodePathA)}`;
```

**Lesson learned from the graph API:** the node path `banger-test/node-a-123` is used as-is in the URL, e.g. `GET /api/graph/nodes/banger-test/node-a-123`.

---

## 10. Status Code Surprises

APIs don't always follow REST conventions. Document quirks in testing plans and collection descriptions — never silently swallow unexpected codes.

Known surprises in the local-dev-test-repo target API:

| Endpoint | Expected | Actual | Notes |
|----------|---------|--------|-------|
| `POST /api/graph/nodes` | 201 | **200** | Returns 200 on successful creation |
| `DELETE /api/graph/links/{id}` | 200 | **405** | Links cannot be deleted via API |
| `PATCH /api/graph/nodes/{path}` | 200 or 204 | **200** | Returns updated object |

**Pattern for tests that accept multiple valid codes:**

```javascript
// post-script:
const s = ctx.response.status;
ctx.assert(s === 200 || s === 201, `Expected 200 or 201 on node create, got ${s}`);
```

**For known 405s (delete that can't delete):**

```yaml
response:
  status: 405
  snapshot: false
```

---

## 11. jq Shape Assertion Tips

Shape assertions use `jq` boolean expressions. A few patterns:

```yaml
shape:
  # Check top-level key exists
  - 'has("agents")'

  # Check value type
  - '.agents | type == "array"'

  # Conditional — only assert on non-empty arrays
  - 'if (.agents | length) > 0 then .agents[0] | has("id") else true end'

  # Check response is an object (not null, not array)
  - 'type == "object"'

  # Multiple field alternatives (API may use different field names)
  - '(has("sourcePath") or has("source") or has("from"))'
```

**Tip:** Test your jq expressions against a real response before committing:

```bash
echo '{"agents":[],"total":0}' | jq 'has("agents")'
echo '{"agents":[],"total":0}' | jq '.agents | type == "array"'
```

**Tip:** If the response could be an array OR an object wrapping an array, use:

```javascript
// post-script pattern for extracting items regardless of wrapper:
const items = Array.isArray(ctx.response.body) 
  ? ctx.response.body 
  : (ctx.response.body as any).nodes ?? (ctx.response.body as any).items ?? [];
```

---

## 12. Debugging Failed Runs

### Check the run logs first

Every run writes to `runs/{timestamp}/`:

```bash
# See the summary
cat local-dev-test-repo/runs/$(ls -t local-dev-test-repo/runs | head -1)/summary.json | jq .

# See a specific test's full log
cat local-dev-test-repo/runs/$(ls -t local-dev-test-repo/runs | head -1)/graph--create-graph-node-a.log
```

### Probe the API directly with curl

Before writing (or debugging) a test, verify the endpoint manually:

```bash
BASE_URL=$(grep BASE_URL local-dev-test-repo/envs/local.env | cut -d= -f2)

# GET
curl -s "${BASE_URL}/api/graph/nodes" | jq .

# POST
curl -s -X POST "${BASE_URL}/api/graph/nodes" \
  -H "Content-Type: application/json" \
  -d '{"path":"banger-test/probe","contentType":"text/plain","content":"test","persist":"file"}' | jq .

# PATCH
curl -s -X PATCH "${BASE_URL}/api/graph/nodes/banger-test/probe" \
  -H "Content-Type: application/json" \
  -d '{"title":"Updated"}' | jq .
```

### Run a single collection

```bash
cd local-dev-test-repo
npx tsx ../src/index.ts run --collection graph --env local
```

### Run a single test file

```bash
cd local-dev-test-repo
npx tsx ../src/index.ts run --file tests/collections/graph/create-graph-node-a.yaml --env local
```

---

## 13. Collection Order Matters

The `order` array in `_collection.yaml` is not optional for CRUD collections — it controls execution sequence. If you add a test file, add it to `order` in the right position:

```yaml
order:
  - get-graph-nodes         # baseline read (smoke)
  - create-graph-node-a     # creates data needed by later tests
  - create-graph-node-b
  - get-graph-node          # reads created data
  - modify-graph-node       # mutates data
  - create-graph-link       # creates relationship
  - get-graph-links         # smoke read
  - get-graph-link          # reads created link
  - delete-graph-link       # cleanup (405 — leaves link in place)
  - delete-graph-node-a     # cleanup
  - delete-graph-node-b     # cleanup
```

Tests not listed in `order` still run, but at an unspecified position after the ordered tests. Don't rely on that — always add to `order`.

---

## 14. ctx.http vs curl

`ctx.http.*` and `curl` serve different purposes:

| | `ctx.http.*` | `curl` (via request) |
|---|---|---|
| Used in | `pre`, `post`, `setup`, `teardown` scripts | The actual test request |
| Returns | `BangerResponse` object | Captured by executor |
| Assertions run | No | Yes (status, shape, snapshot) |
| Shows in report | No (side effect only) | Yes |
| Use for | Setup calls, teardown cleanup, data seeding | The thing you're testing |

**Example:** In `setup`, use `ctx.http.post` to load a workspace. In the test itself, use the `request:` block with `method: GET` — that fires curl and runs assertions.

---

## 15. Testing Plans as Living Docs

The `local-dev-test-repo/testing-plans/` directory contains one Markdown file per collection. These are **living documents** — update them as you learn things about the API.

A testing plan records:
- Which endpoints to test and the target test file names
- Snapshot policy decisions
- Shape assertion patterns (so future tests are consistent)
- Skip patterns for dependent tests
- Known API quirks specific to that collection
- Suite membership (`smoke.yaml`, `gets-all.yaml`)

**Read `testing-plans/README.md` before writing a new collection.** It contains shared conventions for auth wiring, workspace loading, stash patterns, etc.

---

## Appendix: Quick Reference Patterns

### Standard pre-script (GET test with auth + var-based path)

```javascript
if (ctx.vars.authHeader) ctx.request.headers['Authorization'] = ctx.vars.authHeader;
const id = ctx.vars.createdResourceId as string;
if (!id) ctx.skip('No resource id — create test may have failed or was skipped');
ctx.request.path = `/api/resource/${id}`;
```

### Standard post-script (stash from list response)

```javascript
const body = ctx.response.body as any;
const items = Array.isArray(body) ? body : (body.items ?? body.results ?? []);
ctx.log(`Got ${items.length} items`);
if (items.length > 0) {
  ctx.vars.firstItemId = items[0].id;
  ctx.log(`Stashed first item id: ${ctx.vars.firstItemId}`);
}
```

### Standard post-script (stash from create response)

```javascript
const s = ctx.response.status;
ctx.assert(s === 200 || s === 201, `Expected 200/201 on create, got ${s}`);
const body = ctx.response.body as any;
ctx.vars.createdItemId = body.id ?? body.path;
ctx.log(`Created: ${ctx.vars.createdItemId}`);
```

### Standard post-script (delete with var clear)

```javascript
ctx.assert(ctx.response.status === 200, `Expected 200 on delete, got ${ctx.response.status}`);
ctx.vars.createdItemId = null;
ctx.log('Resource deleted and var cleared');
```

### Teardown cleanup block

```javascript
const headers = {};
if (ctx.vars.authHeader) headers['Authorization'] = ctx.vars.authHeader;

if (ctx.vars.createdItemId) {
  ctx.log(`Teardown: cleaning up item "${ctx.vars.createdItemId}"`);
  try {
    const res = await ctx.http.delete(`/api/resource/${ctx.vars.createdItemId}`, { headers });
    ctx.log(`Delete response: ${res.status}`);
  } catch (err) {
    ctx.log(`Teardown cleanup failed (non-fatal): ${err.message}`);
  }
}
```
