# Product Story: `shogun coverage` — API Test Coverage Matrix

**Status:** Ready for implementation  
**Created:** 2026-04-24  
**Scope:** New subcommand. Engine changes: `src/commands/coverage.ts` (new), `src/index.ts` (additions only).

---

## Problem

We have two rich data sources that have never been cross-referenced:

1. **The OpenAPI spec** — every endpoint the API declares, reachable through `fetchSpec()` + the same parsing already built in `spec.ts`
2. **The test suite** — every test YAML in `tests/collections/`, each of which declares `request.method` and `request.path`

Right now there is no way to answer: _"Which endpoints do we have zero tests for?"_ or _"How many tests hit `/api/graph/nodes`?"_ The `coverage` command bridges this gap with a single read-only text report — no test runs, no HTTP calls, just file I/O + spec fetch.

---

## Goal

Add `shogun coverage` as a new subcommand that:

1. Fetches and parses the OpenAPI spec (same path as `shogun spec --list`)
2. Scans every test YAML in the configured collections directory
3. Matches each test to its spec endpoint using a three-tier path matching algorithm
4. Emits a coverage matrix showing covered vs. uncovered endpoints, grouped clearly

---

## CLI Interface

```bash
# Full matrix — fetches spec via config.spec.path + BASE_URL from default env
shogun coverage

# Load a specific env file (required when spec is a live URL)
shogun coverage --env local

# Scope the test-side to one collection (spec side stays full)
shogun coverage --collection graph

# Scope the test-side to a named suite
shogun coverage --suite smoke

# Scope the spec-side to a tag group (same as shogun spec --tag)
shogun coverage --tag Agents

# Show only uncovered endpoints (useful for gap analysis)
shogun coverage --uncovered

# Format options
shogun coverage --format markdown   # Markdown table (paste into docs)
shogun coverage --format json       # Machine-readable (for scripts/dashboards)

# Override spec source (same as shogun spec positional arg)
shogun coverage specs/enigma-api.json
shogun coverage http://localhost:5000/swagger/v1/swagger.json

# --cwd is inherited from global arg parsing (already implemented in index.ts)
```

---

## Output Formats

### `pretty` (default)

```
Coverage Report — enigma API v1.2.3
  Spec endpoints:  87
  Tests scanned:   72  (8 collections)
  Covered:         45  (51.7%)
  Uncovered:       42

COVERED (45)
  GET    /api/graph/nodes                    2 tests   graph
  POST   /api/graph/nodes                    1 test    graph
  GET    /api/graph/nodes/{path}             1 test    graph
  PATCH  /api/graph/nodes/{path}             1 test    graph
  DELETE /api/graph/nodes/{path}             2 tests   graph
  GET    /api/code/checkpoints               1 test    code
  ...

UNCOVERED (42)
  GET    /api/code/search/symbols
  POST   /api/code/analyze
  DELETE /api/graph/links/{id}
  ...

Tip: --uncovered to see only gaps  |  --format markdown to embed in a doc
```

### `markdown` (`--format markdown`)

```markdown
## API Coverage Report

> 45 / 87 endpoints covered (51.7%) · 72 tests · 8 collections

| Status | Method | Endpoint | Tests | Collections |
|--------|--------|----------|-------|-------------|
| ✅ | GET | `/api/graph/nodes` | 2 | graph |
| ✅ | POST | `/api/graph/nodes` | 1 | graph |
| ❌ | GET | `/api/code/search/symbols` | 0 | — |
| ❌ | DELETE | `/api/graph/links/{id}` | 0 | — |
```

### `json` (`--format json`)

```json
{
  "summary": {
    "apiTitle": "enigma API",
    "apiVersion": "1.2.3",
    "totalEndpoints": 87,
    "coveredEndpoints": 45,
    "uncoveredEndpoints": 42,
    "totalTests": 72,
    "collections": 8,
    "coveragePct": 51.7
  },
  "endpoints": [
    {
      "method": "GET",
      "path": "/api/graph/nodes",
      "tag": "Graph",
      "summary": "List all graph nodes",
      "covered": true,
      "tests": [
        {
          "name": "Graph Nodes List",
          "file": "tests/collections/graph/get-graph-nodes.yaml",
          "collection": "graph",
          "staticPath": "/api/graph/nodes",
          "tags": ["smoke", "graph", "readonly"]
        }
      ]
    },
    {
      "method": "GET",
      "path": "/api/code/search/symbols",
      "tag": "Code",
      "summary": "Search for symbols",
      "covered": false,
      "tests": []
    }
  ]
}
```

---

## Internal Design

### New file: `src/commands/coverage.ts`

#### `CoverageArgs` interface

```typescript
export interface CoverageArgs {
  specSource?: string;   // positional override
  env?: string;          // --env
  collection?: string;   // --collection (test-side filter)
  suite?: string;        // --suite (test-side filter)
  tag?: string;          // --tag (spec-side filter)
  uncovered?: boolean;   // --uncovered  
  format?: 'pretty' | 'json' | 'markdown';
  cwd?: string;
}
```

#### `TestEntry` interface (internal)

```typescript
interface TestEntry {
  name: string;
  file: string;           // relative path from cwd
  collection: string;
  staticPath: string;     // raw request.path from YAML
  method: string;         // normalized to uppercase
  tags: string[];
  matchedSpecKey?: string; // "GET /api/graph/nodes" — set after matching
}
```

#### `SpecEndpoint` interface (internal)

```typescript
interface SpecEndpoint {
  method: string;         // uppercase
  path: string;           // raw OAS path e.g. /api/graph/nodes/{path}
  tag?: string;
  summary?: string;
  tests: TestEntry[];     // populated during match phase
}
```

### Execution flow

```
coverage(args)
  │
  ├─ 1. loadConfig(cwd)
  ├─ 2. loadEnv(envName, config, cwd)          [optional, for live spec]
  ├─ 3. fetchSpec(specSource, config, env, cwd) [reuse from loader.ts]
  │      └─ parse JSON → OpenApiSpec
  │
  ├─ 4. extractSpecEndpoints(openApi, tagFilter)
  │      └─ iterate paths × methods → SpecEndpoint[]
  │
  ├─ 5. collectTestEntries(config, cwd, collectionFilter, suiteFilter)
  │      ├─ if suite: loadSuite() → collections list
  │      ├─ else if collection: [collectionFilter]
  │      ├─ else: discoverCollections()
  │      └─ for each collection:
  │           readdirSync(collectionDir) → *.yaml (not _collection.yaml)
  │           raw yaml.load() → extract name, request.method, request.path, tags
  │           [no full TestDefinitionSchema validation — lightweight parse]
  │
  ├─ 6. matchTests(testEntries, specEndpoints)
  │      └─ for each test: matchTestToSpecEndpoint(method, path, specEndpoints)
  │           → set test.matchedSpecKey
  │           → push test into SpecEndpoint.tests[]
  │
  └─ 7. renderCoverage(specEndpoints, summary, format, uncoveredOnly)
```

### Path matching algorithm (three tiers)

The core challenge: test files declare a **static** `request.path` that may be:
- An exact endpoint path: `/api/graph/nodes`
- A path with a `__placeholder__` terminal: `/api/graph/nodes/__placeholder__`
- A path with a `${VAR}` token: `/api/code/class/${CLASS_NAME}`
- A path that covers a multi-segment tail: `/api/code/class/__placeholder__` (maps to `/api/code/class/{className}/{filePath}`)

The OAS spec declares template paths: `/api/graph/nodes/{path}`, `/api/code/class/{className}/{filePath}`

```
function matchTestToSpecEndpoint(method, testPath, specEndpoints):

  TIER 1 — Exact match
    specEndpoints where method matches AND path === testPath
    → if found, return it (highest confidence)

  normalize testPath:
    split by "/"
    replace each segment where:
      segment === "__placeholder__"
      OR segment starts with "${"
      OR segment contains "{" (already a template var)
    → with sentinel "__W__"

  TIER 2 — Segment-count-equal template match
    for each spec endpoint where method matches:
      normalize spec path: replace {param} segments with "__W__"
      if testSegs.length !== specSegs.length → skip
      match segment-by-segment:
        - if either side is "__W__" → matches (wildcard)
        - else must be equal strings
      score = count of non-wildcard exact segment matches
    → pick highest-scoring candidate (most specific match)

  TIER 3 — Prefix fallback (for multi-segment dynamic tails)
    extract static prefix of testPath = segments before first __W__
    for each spec endpoint where method matches:
      if spec path starts with (staticPrefix + "/") OR equals staticPrefix:
        candidate (may be ambiguous — multiple spec paths share prefix)
    → pick spec path whose segment count is closest to testPath segment count
    → flag as "approximate" match in JSON output

  return best match key ("METHOD /spec/path") or undefined
```

#### Examples

| Test path | Spec path | Tier matched |
|-----------|-----------|--------------|
| `/api/graph/nodes` | `/api/graph/nodes` | 1 — exact |
| `/api/graph/nodes/__placeholder__` | `/api/graph/nodes/{path}` | 2 — same segment count, wildcard match |
| `/api/code/class/__placeholder__` | `/api/code/class/{className}/{filePath}` | 3 — prefix fallback (segment count differs: 4 vs 5) |
| `/api/code/checkpoints` | `/api/code/checkpoints` | 1 — exact |

---

### Changes to `src/index.ts`

**Add to `USAGE` string:**
```
  shogun coverage                     API test coverage matrix
  shogun coverage --env local         Load env for live spec fetching
  shogun coverage --collection graph  Scope tests to one collection
  shogun coverage --suite smoke       Scope tests to a named suite
  shogun coverage --tag Agents        Scope spec to a tag group
  shogun coverage --uncovered         Show only uncovered endpoints
  shogun coverage --format json       JSON output (for scripting)
```

**Add to `parseArgs()`:**
```typescript
case '--uncovered': result.uncovered = true; break;
```
_(Note: `--env`, `--collection`, `--suite`, `--tag`, `--format`, `--cwd`, and positional `specSource` already exist in ParsedArgs — no changes needed for those.)_

**Add to `switch (subcommand)`:**
```typescript
case 'coverage': {
  const exitCode = await coverage({
    specSource: args.specSource,
    env: args.env,
    collection: args.collection,
    suite: args.suite,
    tag: args.tag,
    uncovered: args.uncovered,
    format: args.format as 'pretty' | 'json' | 'markdown' | undefined,
    cwd: args.cwd,
  });
  process.exit(exitCode);
  break;
}
```

**Add import:**
```typescript
import { coverage } from './commands/coverage.js';
```

**Add to `ParsedArgs`:**
```typescript
uncovered?: boolean;
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Report generated successfully (even if coverage is 0%) |
| 1 | Fatal error: spec fetch failed, config invalid, no tests found |

The command never fails due to low coverage — it's purely informational.

---

## Key Constraints

1. **No HTTP calls to the API under test** — this command reads spec + test files only; it never runs requests.
2. **No full test validation** — test YAML files are parsed lightly (just extract `name`, `request.method`, `request.path`, `collection`, `tags`). No Zod schema validation, no pre/post script execution, no env interpolation.
3. **Spec fetch still respects env** — the spec URL may need `BASE_URL` from an env file, so `--env` is supported for the spec-fetch step only.
4. **Read-only** — no files are created or modified. No `runs/` directory entries.
5. **Static path analysis only** — tests that use `ctx.request.path` assignment in their `pre` script are analyzed based on the static `request.path` declared in the YAML (often `__placeholder__`). This is by design: the coverage command is a static analysis tool.

---

## Files to Create / Modify

| File | Change |
|------|--------|
| `src/commands/coverage.ts` | **Create** — ~300 lines, self-contained |
| `src/index.ts` | **Modify** — add import, `uncovered` to ParsedArgs, USAGE entry, switch case |

No changes to `src/types.ts`, `src/loader.ts`, or any other existing file beyond `index.ts`.

---

## Out of Scope (Future)

- **Branch coverage** (did the test exercise all response codes for an endpoint?) — not in this story
- **`shogun coverage --watch`** — live re-analysis on file change
- **Coverage thresholds / CI gate** — e.g., exit 1 if coverage < 80% (easy add-on later; arg name suggestion: `--min-coverage <n>`)
- **Test-name-based heuristics** (scanning the `pre:` script body for `ctx.request.path =`) — too fragile; static YAML path is the source of truth
