---
name: shogun-test-writer
description: Writing, debugging, and maintaining shogun tests for testing API. Shogun replaces the needs for tools like Postman or Hoppscotch and goes bare metal on API testing.
---


## Protocol: When Given a Test Run With Failures

**When the user pastes test run output containing failures, the ONLY correct response is:**

1. **Produce a root-cause breakdown table** — grouped by category, not by test:

   | Group | Count | Root Cause |
   |-------|-------|-----------|
   | URL encoding | 7 | `encodeURIComponent(filePath)` encodes `/` → `%2F` → 404 on file-path endpoints |
   | Scope collision | 1 | Duplicate `const ws` in `delete-note` pre-script — compile error |
   | Wrong shape | 2 | `type == "array"` asserted on wrapped-object responses |
   | Missing header | 1 | `ctx.http.get()` missing workspace header in pre-script |
   | Cascade | 1 | Secondary failure — caused by wrong shape in prior test |

2. **For each ambiguous group** (unexpected status code, wrong shape, missing field) — **verify the API contract** before concluding it's a test bug or API bug:

   ```bash
   # Confirm what the spec actually says this endpoint should do
   shogun spec --endpoint /api/the/failing/path --method POST
   shogun spec --schema TheRequestBodySchemaName
   ```

   Compare the spec contract against what the test asserts. If they diverge, decide:
   - **Spec matches test, API returned wrong thing** → API bug (keep test, let it fail with a `# BUG:` comment)
   - **Spec differs from test assumptions** → test bug (fix the test to match the spec)
   - **Spec is missing this endpoint entirely** → likely an unreleased or removed endpoint — flag it

3. **For each group**, state:
   - The exact line(s) of code responsible
   - Whether this is a **test bug** (fix the test) or an **API bug** (write test to assert correct behavior and let it fail)
   - The specific fix proposed

4. **Halt and wait for confirmation** — do not modify any file until the user reviews the breakdown and approves the proposed fixes

**Never** start editing files in response to a pasted failure run. Always produce the breakdown first.

---

## Mandatory Pre-Flight (Every Session)

Before touching any test file, complete this checklist. Do not skip steps.

1. **Read [`agents.md`](../../agents.md)** — AGENTS.md rules, especially the two-suite invariant
2. **Read [`docs/testing-journal.md`](../testing-journal.md)** — all 15 sections
3. **Read the testing plan** for the collection you're touching: `local-dev-test-repo/testing-plans/{collection}.md`
4. **Read `_collection.yaml`** for the collection — understand setup/teardown/var init
5. **Read the suite file** being run (e.g., `tests/suites/api-testapp-1.yaml`) — understand which `vars:` are injected

---

## Rule 1 — Read the Entire Script Before Writing One Line

Inline YAML script blocks (`pre: |`, `post: |`, `setup: |`, `teardown: |`) are compiled as a **single TypeScript lexical scope**. A `const ws` at line 2 and another `const ws` at line 31 is a compile error.

**Before adding any code to an existing inline script:**
1. Read the ENTIRE existing block top-to-bottom with `read_file`
2. List every `const`/`let`/`var` name already declared
3. Only then write new code

**Never** edit the middle or end of a script block without reading what came before it.

---

## Rule 2 — File Path Params: Use `encodeFilePath()`, Not `encodeURIComponent`

The Enigma/TinyAST API uses **real forward slashes** as path separators in file-based resource identifiers.

- `encodeURIComponent(filePath)` converts `/` to `%2F` → **breaks routing (404)**
- Bare `${filePath}` skips encoding of spaces, `#`, `?`, `&` etc. → **also wrong**

The correct fix is **per-segment encoding** via the shared `url` script helper:

```javascript
// ✅ CORRECT — use the shared library function
const { encodeFilePath } = ctx.scripts.url;
ctx.request.path = `/api/code/structure/${encodeFilePath(filePath)}`;

// ❌ WRONG — %2F breaks the route, returns 404
ctx.request.path = `/api/code/structure/${encodeURIComponent(filePath)}`;

// ❌ ALSO WRONG — spaces/# etc. not encoded
ctx.request.path = `/api/code/structure/${filePath}`;
```

**`encodeFilePath` is only needed for the `filePath`/`dirPath` segment.** Identifiers that never contain `/` (like `className`, `methodName`, `propertyName`) still use bare `encodeURIComponent`. Query-string values always use `encodeURIComponent`.

```javascript
// Mixed example — class + file path endpoint
ctx.request.path = `/api/code/class/${encodeURIComponent(className)}/${encodeFilePath(filePath)}`;
```

**See also:** [`local-dev-test-repo/docs/scripts-library.md`](../../local-dev-test-repo/docs/scripts-library.md) — full library reference including `encodeFilePath` and `auth` helpers.

**`shogun lint` will catch** bare `encodeURIComponent(` on a `ctx.request.path` line and flag it as an error.

This applies to all endpoints with `{filePath}` or `{dirPath}` in the URL:
- `/api/code/structure/{filePath}`
- `/api/code/raw/{filePath}`
- `/api/code/node/{filePath}`
- `/api/code/class/{className}/{filePath}`
- `/api/code/comments/{className}/{filePath}`
- `/api/code/method/{className}/{methodName}/{filePath}`
- `/api/code/property/{className}/{propertyName}/{filePath}`
- `/api/code/clones/find/{filePath}`
- `/api/fs/exists/{filePath}`
- `/api/fs/file/{filePath}`
- `/api/fs/list/{dirPath}`
- `/api/fs/verify/{filePath}`

---

## Rule 3 — `ctx.http.*` Calls Must Carry Their Own Headers

`ctx.request.headers['X-TinyAST-Workspace'] = ws` only affects the **curl request**. It does NOT propagate to `ctx.http.*` calls. These are two completely separate HTTP mechanisms.

Every `ctx.http.get/post/put/patch/delete` call that hits a workspace-aware endpoint must explicitly pass the header:

```javascript
// ✅ CORRECT — header wired explicitly
const ws = (ctx.vars.workspaceName as string) ?? '';
const wsHeaders = ws ? { 'X-TinyAST-Workspace': ws } : {};
const res = await ctx.http.get(`/api/fs/exists/${filePath}`, { headers: wsHeaders });

// ❌ WRONG — ctx.request.headers does not carry over to ctx.http calls
ctx.request.headers['X-TinyAST-Workspace'] = ws;
const res = await ctx.http.get(`/api/fs/exists/${filePath}`); // no workspace header
```

**Consequence of omission:** When multiple workspaces are loaded on the server, the API returns:
```json
{"error": "Multiple workspaces are loaded. Specify one via the 'X-TinyAST-Workspace' header"}
```
This returns 400, which causes `ctx.assert(res.status === 200, ...)` to fail.

---

## Rule 4 — Verify Actual API Response Before Writing Shape Assertions

Never write `shape:` assertions from docs, guesses, or mental models. Always verify against a real response first.

**Before writing any shape assertion:**
```bash
# Substitute BASE_URL and WORKSPACE from local.env
BASE_URL=$(grep BASE_URL local-dev-test-repo/envs/local.env | cut -d= -f2)
WORKSPACE=api-testapp-1

curl -s "${BASE_URL}/api/deps/hotspots?top=10" \
  -H "X-TinyAST-Workspace: ${WORKSPACE}" | jq 'keys'
```

**If the response is `{"files": [...], "_sensors": [...]}` — the shape is NOT `type == "array"`.**

Write the assertion against the actual wrapper structure:
```yaml
shape:
  - 'has("files")'
  - '.files | type == "array"'
```

And fix the post-script to match:
```javascript
// Wrong — body is not an array
const items = Array.isArray(body) ? body : [];

// Correct — unwrap the envelope
const items = Array.isArray(body) ? body : (body.files ?? body.links ?? body.items ?? []);
```

---

## Rule 5 — Snapshot Failures After a Snapshot Run Mean the Test Was Already Failing

`NEEDS BASELINE` after `shogun snapshot` = the test was failing when snapshot ran. Snapshots are only written for passing tests.

**Diagnosis flow:**
1. Test shows `NEEDS BASELINE` → the test failed during the snapshot run
2. Look at the test's shape assertions — do they match the actual response?
3. Fix the test first, run snapshot again, then commit the baseline

**Snapshot staleness** (response content changed) is a separate issue from shape assertion failures. Both require different fixes:
- Shape fail → fix the assertion
- Stale snapshot (only `_sensors.changedAt` changed) → add `ignore_fields` for `_sensors` fields

**Standard `_sensors` ignore fields** for any snapshot-enabled test against this API:
```yaml
ignore_fields:
  - '**._sensorsEpoch'
  - '**._sensors[*].changedAt'
  - '**._sensors[*].recentOutput'
  - '**._sensors[*].epoch'
```

---

## Rule 6 — Tests Must Assert Correct Behavior, Not Current Behavior

The purpose of tests is to find bugs, not to be green.

| Pattern | What it means |
|---------|--------------|
| `ctx.assert(s === 200, ...)` | "This endpoint must return 200 — fail until it does" |
| `ctx.assert(s === 200 \|\| s === 404, ...)` after a create | Hiding a bug — one of these is wrong |
| `ctx.log('not supported')` with no assert | Guaranteed green checkbox that lies |
| `if (s === 404) { return; }` | Test that passes when the API is broken |

**When you discover an API bug:**
1. Write the test to assert the **correct** behavior (e.g., `ctx.assert(s === 200, ...)`)
2. Let it fail — the failing test IS the bug report
3. Add a `# BUG:` comment at the top of the test file explaining what's wrong

**When a non-2xx is legitimately correct:**
```javascript
// ✅ Confirmed — DELETE /api/graph/links returns 405 (no delete endpoint)
ctx.assert(s === 405, `Expected 405 (confirmed API limitation — no DELETE endpoint for links), got ${s}`);

// ✅ Confirmed — verify-after-delete returns 404
ctx.assert(s === 404, `Expected 404 confirming node is gone, got ${s}`);
```
The assertion message must explain WHY that code is expected.

---

## Rule 7 — Var Cascade Failures Are Always a Secondary Symptom

When a test fails with "X is not set — prior test must have run first", the root cause is in the **prior test's post-script**, not in this test's pre-script.

**Example:**
- `get-link-by-id` fails: `"firstLinkId is not set — get-links must have run first"`
- Root cause: `get-links` post-script does `Array.isArray(body) ? body : []` but body is `{"links": [...]}`
- So `items` is always empty, `firstLinkId` is never stashed

**Diagnosis:** Trace backward. Find the test that was supposed to set the var. Look at its post-script. Look at what the API actually returned.

---

## Rule 8 — `deps` Collection: Response Shapes Are Wrapped Objects

The `/api/deps/*` endpoints return wrapped objects, not bare arrays. Do not assert `type == "array"`.

| Endpoint | Actual wrapper | Array field |
|----------|---------------|-------------|
| `GET /api/deps/hotspots` | `{"files": [...], "_sensors": [...]}` | `files` |
| `GET /api/deps/links` | `{"count": N, "links": [...], "_sensors": [...]}` | `links` |
| `GET /api/deps/files/{path}` | `{"dependencies": [...], ...}` | `dependencies` |
| `GET /api/deps/impact/{path}` | `{"impacted": [...], ...}` | `impacted` |
| `GET /api/deps/methods/{path}` | object | various |
| `GET /api/deps/order` | `{"order": [...], ...}` | `order` |

**Standard post-script pattern for unwrapping:**
```javascript
const body = ctx.response.body as any;
const items = Array.isArray(body)
  ? body
  : (body.files ?? body.links ?? body.dependencies ?? body.impacted ?? body.order ?? []);
ctx.log(`Items returned: ${items.length}`);
```

---

## Rule 9 — The `workspaceName` Var Flows Through the `workspace-load` Fixture

`ctx.vars.workspaceName` is set by the `workspace-load` setup fixture. It is not set by each collection's own setup in the `code` collection — the collection delegates to the fixture.

**Flow:**
```
suite vars: { WORKSPACE_NAME: "api-testapp-1" }
  → setup_fixtures: [workspace-load]
    → workspace-load.yaml reads ctx.vars.WORKSPACE_NAME
    → sets ctx.vars.workspaceName = "api-testapp-1"
  → collection setup: reads ctx.vars.workspaceName (already set)
  → test pre-scripts: read ctx.vars.workspaceName
```

If `ctx.vars.workspaceName` is null in a pre-script, the workspace-load fixture either didn't run or WORKSPACE_NAME wasn't in the suite vars. Check the suite file first.

The `deps` collection does NOT use `setup_fixtures: [workspace-load]` — it does its own workspace load in `setup:`. This means `_fixtureLoaded_workspace` does NOT get set by deps collection setup, and if another collection using the fixture runs later in the same session, it will re-load the workspace.

---

## Rule 10 — After Every Edit: State What You Expect

Before submitting an edit, explicitly state:
1. What status code the test should now assert
2. What shape the response must match
3. Whether any `ctx.vars.*` gets set in the post-script, and what value it should have after a success

This creates a verifiable prediction. If the test output contradicts your prediction, the prediction (and therefore the mental model behind the edit) was wrong.

---

## Quick Reference: Standard Pre-Script Patterns

### GET test with file-path param (no encoding)
```javascript
const ws = (ctx.vars.workspaceName as string) ?? '';
if (ws) ctx.request.headers['X-TinyAST-Workspace'] = ws;

const filePath = (ctx.vars.filePath as string) || ctx.env.FILE_PATH || '';
ctx.assert(!!filePath, 'FILE_PATH is not set — required for this test');
ctx.request.path = `/api/code/structure/${filePath}`;
```

### Pre-script with a `ctx.http` verification call
```javascript
const ws = (ctx.vars.workspaceName as string) ?? '';
if (ws) ctx.request.headers['X-TinyAST-Workspace'] = ws;
const wsHeaders = ws ? { 'X-TinyAST-Workspace': ws } : {};

// ← Every ctx.http call needs its own wsHeaders
const checkRes = await ctx.http.get(`/api/fs/exists/${filePath}`, { headers: wsHeaders });
ctx.assert(checkRes.status === 200, `File not found: ${checkRes.status}`);
```

### Inline script with multiple HTTP sub-calls — avoid name collisions
```javascript
// Declare ws ONCE at the top of the script
const ws = (ctx.vars.workspaceName as string) ?? '';
if (ws) ctx.request.headers['X-TinyAST-Workspace'] = ws;
const wsHeaders = ws ? { 'X-TinyAST-Workspace': ws } : {};

// Reuse wsHeaders and ws for all sub-calls — do NOT re-declare
const r1 = await ctx.http.get('/api/something', { headers: wsHeaders });
const r2 = await ctx.http.post('/api/other', body, { headers: wsHeaders });
```

---

## Common Mistakes Cheat Sheet

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| `encodeURIComponent(filePath)` where filePath has `/` | 404 — `%2F` breaks routing | Use raw filePath |
| `const ws = ...` twice in same script | TransformError compile fail | Read whole script before adding decls |
| `ctx.http.get(url)` with no headers | 400 — missing workspace header | Always pass `{ headers: wsHeaders }` |
| `shape: type == "array"` on wrapped endpoint | Shape fail always | Curl endpoint, write from real response |
| `ctx.assert(s === 200 \|\| s === 404)` on a create | Passes even when API broken | One success code only |
| `if (s === 404) { return; }` | Test always passes | Remove; assert the correct code |
| Snapshot after shape fail | `NEEDS BASELINE` forever | Fix assertions first, snapshot after |
