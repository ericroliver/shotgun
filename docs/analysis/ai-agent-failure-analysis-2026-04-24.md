# AI Agent Failure Analysis — Shogun Test Maintenance
**Date:** 2026-04-24  
**Context:** 2 days of test regressions during api-testapp-1 workspace refactor  
**Author:** Post-mortem self-analysis after 12 failing tests in `code` + `deps` collections

---

## Executive Summary

Every failure in the run trace can be attributed to one of **five root-cause categories**, all of which stem from missing context and process, not from individual bugs in isolation. The agent (me) was operating with an incomplete mental model of the system each session, writing code that looked plausible but violated documented invariants, and then "fixing" failures in ways that hid bugs rather than surfacing them.

This document categorizes each failure, names the root cause, and ends with a proposed set of rules and a skill file outline that would prevent recurrence.

---

## Failure Inventory

### Group 1 — URL encoding of file paths (7 failures)

**Tests:** `get-structure`, `get-raw-file`, `get-node`, `get-class`, `get-comments`, `get-method`, `get-property`

**Symptom:** All 404. Request URL shows `backend%2FTodoApi%2FData%2FTodoDbContext.cs` — slashes percent-encoded.

**Actual request:**
```
GET http://m1x-remote:3080/api/code/structure/backend%2FTodoApi%2FData%2FTodoDbContext.cs
```

**API error:** `"File not found in workspace: backend%2FTodoApi%2FData%2FTodoDbContext.cs"`

**Root cause in code:** Every one of these pre-scripts contains:
```javascript
ctx.request.path = `/api/code/structure/${encodeURIComponent(filePath)}`;
```

**Why it's wrong:** The testing journal (§8) explicitly documents this gotcha:
> Do NOT `encodeURIComponent` the full thing — that would encode the `/` and break the route.

The API uses **real forward slashes** as path separators in resource identifiers. `backend/TodoApi/Data/TodoDbContext.cs` must appear as-is in the URL — `encodeURIComponent` converts `/` to `%2F` and the API can't find the file.

**The fix:** Remove `encodeURIComponent` from all path-param pre-scripts for file path arguments. Use:
```javascript
ctx.request.path = `/api/code/structure/${filePath}`;
```

**AI failure mode:** Reflexively applied `encodeURIComponent` to a path parameter because "it's a URL, URLs need encoding." Did not check whether this specific API uses path slashes as-is. Did not check the testing journal before writing these pre-scripts.

---

### Group 2 — Duplicate `const ws` declaration (1 failure)

**Test:** `delete-note` — `TransformError: The symbol "ws" has already been declared`

**Root cause in code:** The pre-script in [`delete-note.yaml`](local-dev-test-repo/tests/collections/code/delete-note.yaml) declares `const ws` on two separate lines within the same inline script block:

```javascript
// Line ~21:
const ws = (ctx.vars.workspaceName as string) ?? '';
if (ws) ctx.request.headers['X-TinyAST-Workspace'] = ws;

// ... (several lines of code) ...

// Line ~31 — DUPLICATE DECLARATION:
const ws = (ctx.vars.workspaceName as string) ?? '';
const wsHeaders: Record<string, string> = ws ? { 'X-TinyAST-Workspace': ws } : {};
```

TypeScript/esbuild rejects this at compile time with a lexical scope violation.

**AI failure mode:** The entire `pre: |` YAML block is compiled as a single TypeScript function scope. When I edited the script in sections or added to an existing script, I didn't trace the entire script body from top to bottom as one continuous scope. I added a second `const ws = ...` without noticing the first was already there 10 lines above.

**The rule this violates:** An inline YAML script block is one TypeScript lexical scope — every `const`/`let`/`var` must be unique within it. Before writing any `const X = ...` line, scan the entire existing script for an existing `const X`.

---

### Group 3 — Wrong shape assertions for wrapped-object responses (2 failures + 1 cascade)

**Tests:** `deps/get-hotspots`, `deps/get-links` (cascade: `get-link-by-id`)

**Symptom:** Shape assertion `type == "array"` fails with 200 OK.

**Actual response bodies:**
- `GET /api/deps/hotspots?top=10` → `{"files":[...], "_sensors":[...], "_sensorsEpoch":4}`
- `GET /api/deps/links` → `{"count":0, "links":[], "_sensors":[...], "_sensorsEpoch":4}`

**The shape assertions say:**
```yaml
shape:
  - 'type == "array"'
```

**The response is an object**, not a bare array. The assertion is categorically wrong. It will always fail.

**Cascade:** Because `get-links` post-script does `Array.isArray(body) ? body : []`, it gets an empty array instead of `body.links`, and `ctx.vars.firstLinkId` is never set. `get-link-by-id` pre-script then fails with `"firstLinkId is not set"`.

**Root cause (compound):**

1. **I asserted a shape I didn't verify.** I likely copied a pattern from a different endpoint (or assumed from docs) without curling the actual endpoint first to see what it returns.

2. **I may have been looking at the API spec and it said the response was an array**, but the actual implementation wraps the array in an object. This is a real API shape discrepancy — and the correct response is to **document it as a potential API bug** and write the assertion against what the API actually returns while noting the deviation.

3. **The snapshot was taken against incorrect data** (or never successfully taken against this endpoint's real shape), compounding the problem.

**The rule:** Before writing `shape:` assertions, curl the endpoint directly and inspect the response. Never guess the shape from docs alone.

---

### Group 4 — `ctx.http` call missing workspace header (1 failure)

**Test:** `post-comment-note`

**Symptom:** Pre-script verification call to `GET /api/fs/exists/{filePath}` returns 400:
```
{"error":"Multiple workspaces are loaded. Specify one via the 'X-TinyAST-Workspace' header"}
```

**The request headers log shows:** `{"Content-Type":"application/json","Accept":"application/json"}` — no `X-TinyAST-Workspace` header.

**The pre-script code:**
```javascript
const ws = (ctx.vars.workspaceName as string) ?? '';
if (ws) ctx.request.headers['X-TinyAST-Workspace'] = ws;
// ...
const existsRes = await ctx.http.get(`/api/fs/exists/${filePath}`, {
  headers: ws ? { 'X-TinyAST-Workspace': ws } : {}
});
```

The pattern looks correct — `ws ? { header } : {}` — but the debug output proves the header isn't being sent. This is likely a `ctx.vars.workspaceName` state issue: the variable is either not set at the point the `code` collection pre-scripts run, or the `ctx.http` options object has a different merge behavior than expected.

**Important distinction:** `ctx.request.headers` is the curl request — it gets the workspace header from `if (ws) ctx.request.headers[...] = ws`. But `ctx.http.get()` is a separate programmatic HTTP call — it needs headers passed explicitly in `{ headers: {...} }`. These are two different code paths with different header inheritance.

**AI failure mode:** I conflated "I set the workspace header on the curl request" with "the `ctx.http` call also has it." They are completely independent. Every `ctx.http.*` call inside a pre/post/setup/teardown script needs its workspace header wired explicitly.

---

### Group 5 — Snapshot staleness (2 failures, overlapping with Group 3)

**Tests:** `deps/get-hotspots`, `deps/get-links`

Both show snapshot diffs where the only change is `_sensors[0].changedAt` and `recentOutput` line counts. This is the `_sensors` envelope that every API response includes — it's volatile per-build cycle.

**The fix for these specific tests is `ignore_fields`:**
```yaml
ignore_fields:
  - '**._sensors'
  - '**._sensorsEpoch'
```

Or more surgically:
```yaml
ignore_fields:
  - '**._sensors[*].changedAt'
  - '**._sensors[*].recentOutput'
  - '**._sensorsEpoch'
```

**But** — because the shape assertions are also wrong (Group 3), the snapshot failures are secondary. Fix the shape first, update snapshots after.

**AI failure mode:** I ran `shogun snapshot` to capture baselines but the tests were already failing on shape assertions. A snapshot run only captures baselines for tests that pass. If the shape assertion fails, no baseline is written. `NEEDS BASELINE` after a snapshot run = the test was failing during the snapshot run.

---

## Systemic Root Causes (What the Agent Is Missing)

### 1. No persistence between sessions

I start every session with zero memory of what I did or broke in the previous session. I cannot know "I already introduced a `const ws` duplicate in this file" because that knowledge doesn't carry over.

**What would help:** A `CHANGES.md` or "current session diff log" that records what was changed and why, updated at the end of every work block.

### 2. Cannot run tests to self-verify

I write code, you run it, I see results. I have no feedback loop within a session unless you paste output. This means every edit is a guess until the test run.

**What would help:** After every edit to a test file, the agent should list the specific assertions it expects the test to produce, so you can quickly verify correctness without a full suite run.

### 3. Missing "full scope read" discipline before editing inline scripts

YAML inline script blocks (`pre: |`, `post: |`, `setup: |`) are single TypeScript lexical scopes. When editing, I must read the ENTIRE existing block before adding a single line. I was editing the middle/end of scripts without reading what was already at the top.

**What would help:** A rule: before editing any inline `pre:`, `post:`, `setup:`, or `teardown:` script, read the entire existing script and list all declared `const`/`let` names before writing new code.

### 4. Missing "verify the API before writing the assertion" discipline

I was writing shape assertions and expected response shapes based on API docs or guesses, not from curling the actual running endpoint. This is how `type == "array"` ended up on an endpoint that returns `{"files": [...]}`.

**What would help:** A mandatory step before writing any test: curl the endpoint with the test workspace, inspect the raw response, and write the shape assertion from the actual JSON.

### 5. "Make it pass" bias instead of "make it truthful"

When a test fails, the agent reflex is to make it pass. This leads to:
- Widening assertions to accept more status codes
- Adding `|| true` conditions in jq expressions  
- Logging instead of asserting
- Treating API bugs as "known limitations" to work around

The actual goal is the opposite: tests should fail until the API behaves correctly. A failing test is a standing bug report.

**What would help:** An explicit rule: if a test passes after your change because you made the assertion weaker, you have made things worse, not better.

### 6. The URL encoding rule is known and documented but was violated

[`docs/testing-journal.md §8`](../testing-journal.md#8-url-path-encoding-gotcha) explicitly says: do not `encodeURIComponent` path separators for this API. This rule existed. I violated it anyway.

**What would help:** A pre-flight checklist specific to this API before writing any pre-script that builds a URL with a file path param.

### 7. `ctx.http.*` calls need explicit workspace header — NOT automatically inherited

`ctx.request.headers['X-TinyAST-Workspace'] = ws` only affects the curl request. It does not affect `ctx.http.get/post/put/delete` calls. These are two completely separate HTTP mechanisms with separate header management.

Every `ctx.http.*` call that hits an endpoint requiring workspace context must explicitly include `'X-TinyAST-Workspace': ws` in its `headers` option.

**What would help:** A standard pattern documented in the testing journal and enforced as a rule.

---

## What the Skill File Should Encode

The skill file for "shogun test maintenance" should mandate the following steps, in order, for any test editing session:

### Before touching any file
1. Read `agents.md` (AGENTS.md rules)
2. Read `docs/testing-journal.md` in full
3. Read `local-dev-test-repo/testing-plans/` for the relevant collection
4. List the specific tests to be changed and why

### Before writing or editing a pre/post/setup/teardown script
1. Read the ENTIRE existing script block top-to-bottom
2. List all `const`/`let` names already declared
3. Verify no name collision before adding any declaration

### Before writing any shape assertion
1. Curl the live endpoint with the correct workspace header
2. Capture the actual JSON response
3. Write assertions from the actual response, not from docs

### Before constructing any URL with a file path
1. Check if `encodeURIComponent` is needed — for this API, file paths go raw
2. Never encode `/` separators for `api-testapp-1` file path params

### Before writing any `ctx.http.*` call in a script
1. Determine if the endpoint requires `X-TinyAST-Workspace`
2. If yes, always pass `headers: { 'X-TinyAST-Workspace': ws }` explicitly
3. Do NOT assume this header is inherited from `ctx.request.headers`

### After editing any test
1. Predict exactly what status code and body shape the test should produce
2. State whether this is asserting a 2xx (API works correctly) or a non-2xx (known bug or confirmed limitation)
3. If non-2xx: add a `# BUG:` comment explaining why it's expected

### When a test fails
1. Read the raw response body from the run output
2. Determine: is this a test bug or an API bug?
3. If API bug: write the test to assert the CORRECT behavior (which will fail until fixed)
4. If test bug: fix the test

---

## The Failures in This Run — Quick Reference

| Test | Root Cause | Category |
|------|-----------|----------|
| `get-structure` | `encodeURIComponent(filePath)` encodes `/` → 404 | URL encoding |
| `get-raw-file` | Same | URL encoding |
| `get-node` | Same | URL encoding |
| `get-class` | Same | URL encoding |
| `get-comments` | Same | URL encoding |
| `get-method` | Same | URL encoding |
| `get-property` | Same | URL encoding |
| `delete-note` | Duplicate `const ws` declaration in pre-script | Scope collision |
| `post-comment-note` | `ctx.http.get` missing workspace header | Header inheritance misunderstanding |
| `deps/get-hotspots` | `type == "array"` but response is `{"files":[...]}` | Wrong shape + stale snapshot |
| `deps/get-links` | `type == "array"` but response is `{"count":N,"links":[...]}` | Wrong shape + stale snapshot |
| `deps/get-link-by-id` | `firstLinkId` never set because `get-links` post-script got empty array | Cascade from Group 3 |

---

## Action Items Before the Next Edit Session

1. **Create the skill file** from this analysis — to be loaded at the start of every test-editing session
2. **Fix Group 1** (7 tests): remove `encodeURIComponent` from all file-path URL construction in `code` collection pre-scripts
3. **Fix Group 2** (1 test): remove duplicate `const ws` from `delete-note.yaml` pre-script
4. **Fix Group 3** (2 tests): curl `GET /api/deps/hotspots` and `GET /api/deps/links` to confirm actual response shapes, then fix shape assertions and post-scripts accordingly
5. **Fix Group 4** (1 test): investigate whether `ctx.vars.workspaceName` is actually set when `post-comment-note` pre-script runs; add explicit workspace header to `ctx.http.get` call
6. **Re-snapshot** `deps/get-hotspots` and `deps/get-links` after shape is corrected
7. **Add `_sensors` ignore fields** to all snapshot-enabled tests in `deps` collection

---

## One Final Observation

The URL encoding problem (7 tests) is documented in the testing journal. The duplicate declaration (1 test) is a mechanical mistake. The wrong shape assertion (2 tests) is a discovery failure. The missing header (1 test) is a mental model gap.

None of these are hard bugs. Every single one would have been caught by a 30-second read of the file before editing. The skill file needs to make that read **mandatory**, not optional.
