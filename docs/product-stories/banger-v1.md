# Banger — Product Stories: v1 MVP

> Architecture reference: [`docs/technical/architecture.md`](../technical/architecture.md)
> Status: Ready for development

---

## Epic: Core Testing Engine

---

### Story 1 — Project Scaffold & CLI Entrypoint

**As a** developer,
**I want** to run `banger` from the command line,
**so that** I have a working CLI skeleton to build against.

**Acceptance Criteria:**
- [ ] `package.json` configured with `tsx`, `js-yaml`, `dotenv`, `zod`
- [ ] `tsconfig.json` targeting Node 20, ESM
- [ ] `src/index.ts` is the CLI entrypoint using `process.argv` parsing (no heavy CLI framework needed yet)
- [ ] Subcommands recognized: `run`, `snapshot`, `report`, `lint`
- [ ] Unknown subcommands print usage and exit 1
- [ ] `banger --version` prints current version from package.json

**Notes:**
- Use `tsx src/index.ts` as the dev runner
- Add a `bin` entry to package.json pointing to a compiled `dist/index.js` for prod

---

### Story 2 — Environment File Loader

**As a** tester,
**I want** to select a named environment file (e.g. `--env QA`),
**so that** all requests use the correct base URL and credentials without code changes.

**Acceptance Criteria:**
- [ ] `src/loader.ts` exports `loadEnv(envName: string): Record<string, string>`
- [ ] Loads `envs/{envName}.env` using `dotenv`
- [ ] Falls back to `envs/local.env` if `--env` not specified
- [ ] Throws a clear error if the named env file does not exist
- [ ] All loaded vars are accessible as `ctx.env.*` in scripts
- [ ] `BASE_URL`, `AUTH_TOKEN`, `TIMEOUT` are the minimum recognized vars

**Notes:**
- `envs/` directory must exist; `local.env` should be committed as a template
- Actual `.env` files with secrets should be `.gitignore`'d

---

### Story 3 — YAML Test Definition Loader & Validator

**As a** test author,
**I want** to write tests in YAML files,
**so that** I can define API tests without writing code.

**Acceptance Criteria:**
- [ ] `src/loader.ts` exports `loadTestFile(filePath: string): TestDefinition`
- [ ] Parses YAML using `js-yaml`
- [ ] Validates schema using `zod` — reports clear field-level errors on malformed YAML
- [ ] Supports all fields in the test definition format (see [`docs/technical/architecture.md §5`](../technical/architecture.md))
- [ ] `${VAR_NAME}` interpolation applied to all string fields after env is loaded
- [ ] Invalid or missing `request.method` / `request.path` fails validation with actionable message

**Notes:**
- `TestDefinition` type lives in `src/types.ts`
- `body.file` references are resolved relative to the YAML file location

---

### Story 4 — Collection Discovery & Ordering

**As a** tester,
**I want** to run all tests in a collection by name,
**so that** I can group related tests and control execution order.

**Acceptance Criteria:**
- [ ] `src/loader.ts` exports `loadCollection(name: string): Collection`
- [ ] Reads `tests/collections/{name}/_collection.yaml` for metadata and order
- [ ] Discovers all `.yaml` files in the collection directory (excluding `_collection.yaml`)
- [ ] Respects `order:` array in `_collection.yaml` if present; unlisted files appended alphabetically
- [ ] `banger run --collection agents` runs only that collection
- [ ] `banger run` with no flags runs all discovered collections in alphabetical order

---

### Story 5 — curl Executor (Shell Bridge)

**As a** test runner,
**I want** HTTP requests executed via `curl`,
**so that** we use a proven, dependency-free HTTP tool with full shell pipeline compatibility.

**Acceptance Criteria:**
- [ ] `src/executor.ts` builds curl command from `TestDefinition.request`
- [ ] Uses `child_process.spawn` to invoke curl
- [ ] Captures: response body, HTTP status code, duration (ms), content-type header
- [ ] Supports: GET, POST, PUT, PATCH, DELETE methods
- [ ] Auth header injected from `ctx.env.AUTH_TOKEN` if present
- [ ] Custom headers from `request.headers` merged in
- [ ] Query params from `request.params` appended to URL
- [ ] Request body (`request.body.inline` or `request.body.file`) passed via `--data-binary`
- [ ] `TIMEOUT` env var respected (default: 10s)
- [ ] Auth tokens redacted in all log output

---

### Story 6 — Status Code Assertion

**As a** tester,
**I want** to assert the HTTP status code of a response,
**so that** unexpected error codes fail the test immediately.

**Acceptance Criteria:**
- [ ] `src/asserter.ts` checks `response.status` against `TestDefinition.response.status`
- [ ] Passes if they match
- [ ] Fails with message: `Expected HTTP 200, got 404`
- [ ] If `response.status` is omitted in the YAML, no status assertion is run (warn only)
- [ ] Status assertion result recorded in run log `assertions.status`

---

### Story 7 — jq Shape Assertions (Shell Layer)

**As a** tester,
**I want** to write jq expressions that assert facts about the response body,
**so that** I can validate structure without full snapshot equality.

**Acceptance Criteria:**
- [ ] `src/asserter.ts` runs each `response.shape[]` expression via `jq -e` on the response body
- [ ] `jq -e` exits non-zero when expression is falsy — this counts as an assertion failure
- [ ] Each expression is run in a child shell, piped from the captured body
- [ ] On failure: prints the failing jq expression and the response body excerpt
- [ ] All shape results recorded in `assertions.shape` in run log (array of `{expr, passed}`)

**Notes:**
- `jq` must be available on PATH — check on startup and error clearly if missing

---

### Story 8 — Snapshot Baseline Capture

**As a** tester,
**I want** to capture a baseline snapshot of a response,
**so that** future runs can detect unexpected changes.

**Acceptance Criteria:**
- [ ] `banger snapshot` (or `banger run` on first encounter of a test with `snapshot: true`) writes `expected/{collection}/{sanitized_name}.json`
- [ ] Body is normalized before saving: `ignore_fields` paths stripped, keys sorted with `jq -S`
- [ ] Sanitized filename: `{METHOD}_{path_with_slashes_replaced}.json`
- [ ] `banger snapshot --file tests/collections/agents/get-agents.yaml` updates a single test's baseline
- [ ] Snapshot files are human-readable, formatted JSON

---

### Story 9 — Snapshot Diff Assertion

**As a** tester,
**I want** the test runner to diff the actual response against the saved baseline,
**so that** I'm alerted to unexpected API changes.

**Acceptance Criteria:**
- [ ] `src/asserter.ts` normalizes actual response (strip `ignore_fields`, `jq -S`)
- [ ] Runs `diff -u` between normalized expected file and normalized actual
- [ ] If diff is empty: assertion passes
- [ ] If diff is non-empty: assertion fails, diff output included in run log
- [ ] `assertions.snapshot` in run log records pass/fail and diff content
- [ ] If no baseline file exists and `snapshot: true`: test is marked `needs_baseline` (not failed) and user is prompted to run `banger snapshot`

---

### Story 10 — TypeScript Pre/Post Script Execution

**As a** power user,
**I want** to write TypeScript pre and post hooks in my test YAML,
**so that** I can handle auth refresh, extract variables, and run rich assertions.

**Acceptance Criteria:**
- [ ] `src/scripter.ts` wraps inline script content, injects `BangerContext`, transpiles and runs via `tsx` eval
- [ ] `pre` script runs before curl; can mutate `ctx.request.*`
- [ ] `post` script runs after all other assertions; receives `ctx.response.*`
- [ ] `ctx.assert(condition, message)` throws `BangerAssertionError` on failure
- [ ] `ctx.log(message)` writes to stdout and to the per-test log
- [ ] `ctx.vars` is a shared mutable store across all tests in a run
- [ ] `ctx.http.*` methods available for setup/teardown HTTP calls
- [ ] Scripts support `async/await`
- [ ] Uncaught errors in scripts are caught and recorded as test failures with stack trace
- [ ] Auth tokens in script outputs are redacted before logging

---

### Story 11 — Collection Setup & Teardown Hooks

**As a** test author,
**I want** to define setup and teardown scripts at the collection level,
**so that** I can create test data before the suite runs and clean it up after.

**Acceptance Criteria:**
- [ ] `_collection.yaml` `setup` script runs once before the first test in the collection
- [ ] `_collection.yaml` `teardown` script runs once after the last test (even if tests fail)
- [ ] Both scripts receive full `BangerContext`
- [ ] `ctx.vars` set in `setup` is available in all tests and `teardown`
- [ ] If `setup` throws, all tests in the collection are marked `skipped` with reason
- [ ] If `teardown` throws, it is logged but does not affect test results

---

### Story 12 — Test Run Logger

**As a** developer,
**I want** every test run to produce a structured log,
**so that** I can review results, debug failures, and track history over time.

**Acceptance Criteria:**
- [ ] `src/logger.ts` creates `runs/{TIMESTAMP}/` directory at start of each run
- [ ] Writes `summary.json` at the end of the run (schema: see [`docs/technical/architecture.md §12`](../technical/architecture.md))
- [ ] Writes one `.log` JSON file per test: `{collection}--{sanitized_name}.log`
- [ ] `runs/` is added to `.gitignore`
- [ ] `banger report` reads latest run from `runs/` and prints human-readable table to stdout
- [ ] `banger report --run 2026-03-28_20-05-32` reads that specific run

---

### Story 13 — Reporter / Output Formatting

**As a** developer,
**I want** clear, readable terminal output during and after a test run,
**so that** I can see pass/fail at a glance and find failures quickly.

**Acceptance Criteria:**
- [ ] During run: each test prints `→ METHOD /path ... OK` or `→ METHOD /path ... FAIL`
- [ ] FAIL line includes: which assertion failed and a brief reason
- [ ] End of run: summary table showing total/passed/failed/skipped + duration
- [ ] `--format json` outputs `summary.json` content to stdout (for CI/piping)
- [ ] `--format tap` outputs TAP-compatible lines (for TAP consumers)
- [ ] Exit code `0` if all tests pass, `1` if any fail (critical for CI)

---

### Story 14 — `banger lint` — YAML Validation Command

**As a** test author,
**I want** to validate my test YAML files without running them,
**so that** I catch schema errors before wasting a test run.

**Acceptance Criteria:**
- [ ] `banger lint` discovers all YAML files in `tests/`
- [ ] Validates each against the `TestDefinition` zod schema
- [ ] Reports file path + field-level error for every invalid file
- [ ] Exits 0 if all valid, 1 if any invalid
- [ ] Can lint a specific file: `banger lint --file tests/collections/agents/get-agents.yaml`

---

## Epic: Phase 2 (Post-MVP, Backlog)

| Story | Description |
|-------|-------------|
| POST/body support | Request body from file or inline YAML |
| Variable chaining | `ctx.vars` extraction + use across test files |
| Parallel execution | `--parallel N` flag; safe temp file isolation |
| Suite files | Named multi-collection runs |
| Tag filtering | `--tags smoke,agents` |
| `.env` template | `local.env.example` committed, real envs gitignored |
| CI integration guide | GitHub Actions / GitLab CI example configs |
| `ctx.http` implementation | Full HTTP helper for use in scripts |
| Shared scripts | Import helpers from `scripts/auth.ts` etc. |
| OpenAPI import | Auto-generate test stubs from OpenAPI spec |
