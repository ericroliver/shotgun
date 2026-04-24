# Product Story: `shogun spec` — OpenAPI Spec Query Subcommand

**Status:** Ready for implementation
**Created:** 2026-04-24
**Revised:** 2026-04-24 — spec source is a live URL fetched from the running API; no local file copy needed
**Scope:** New CLI subcommand + config extension + agents.md update

---

## Problem Statement

AI agents working with shogun test failures must determine whether a failure is a **test bug** or an **API bug**. To do this intelligently, the agent needs to know the exact contract for the endpoint under scrutiny — what parameters it accepts, what request body schema it expects, and what response shape it promises.

Today, that information lives in two places:

| Resource | Problem |
|----------|---------|
| `local-dev-test-repo/specs/enigma-api.json` | 9,295 lines of JSON — reading the whole file burns massive context window; also goes stale when the API changes |
| `local-dev-test-repo/specs/enigma-api-summary.txt` | Shows only `METHOD /path` pairs — no parameters, no body schema, no response shape |

Neither is usable for precision triage. An agent trying to confirm whether `POST /api/code/checkpoints` expects a required `filePath` query param must either read thousands of lines or guess. And because the local JSON copy must be manually refreshed, it may not match the running server at all.

---

## Solution: `shogun spec`

A new first-class subcommand that **slices and dices the OpenAPI spec** — returning only what is relevant to the current investigation, in a concise human+AI-readable format.

---

## Command Signature

```
shogun spec [spec-source]

  spec-source   Optional override for the spec source. Three forms accepted:
                  1. Full URL:       http://localhost:5000/swagger/v1/swagger.json
                  2. Relative URL:   swagger/v1/swagger.json  (combined with BASE_URL from env)
                  3. Local file:     specs/enigma-api.json     (offline / cached fallback)
                If omitted, reads spec.path from shogun.config.yaml and fetches live.

Environment:
  --env <name>          Load named env file (e.g. local, QA). Required when the
                        spec source is a relative path that needs BASE_URL.
                        Falls back to config.defaults.env if present.

Filters (all optional, combinable):
  --endpoint <path>     Match a specific API path (exact or substring match)
  --method <verb>       HTTP method filter: GET, POST, PUT, PATCH, DELETE
  --tag <name>          Show all endpoints in a tag group (e.g. "Agents")
  --schema <name>       Resolve and display a named component schema
  --search <keyword>    Full-text search across summaries and descriptions

Display modes:
  --list                List all endpoints as METHOD /path (default when no filter)
  --format pretty       Human-readable (default)
  --format json         Raw JSON slice — useful for piping or scripting
  --format markdown     Markdown block — ideal for pasting into docs/issues
```

### Usage Examples

```bash
# Most common — uses spec.path from config, BASE_URL from default env
shogun spec --endpoint /api/workspaces --method GET

# Explicit env selection (when no defaults.env is set)
shogun spec --env local --endpoint /api/workspaces --method GET

# Show all methods for an endpoint
shogun spec --endpoint /api/code/checkpoints

# Show all endpoints in the "Agents" tag group
shogun spec --tag Agents

# Resolve a request body schema by name (follows $ref chains)
shogun spec --schema CheckpointCreateRequest

# Keyword search across all summaries
shogun spec --search "workspace"

# Full URL override — no env needed
shogun spec http://localhost:5000/swagger/v1/swagger.json --endpoint /api/workspaces

# Relative URL override — BASE_URL from env is the host
shogun spec swagger/v1/swagger.json --env local --endpoint /api/workspaces

# Local file fallback — useful when server is down
shogun spec specs/enigma-api.json --endpoint /api/workspaces

# Emit JSON for programmatic use
shogun spec --endpoint /api/agents --format json
```

---

## Source Resolution

The command resolves the spec source using this priority order:

```
1. First positional argument (overrides config always)
2. spec.path from shogun.config.yaml
3. Error — exit 1 with a helpful message
```

For each source, the **type** is determined:

| Source form | Detection | Fetch method |
|-------------|-----------|--------------|
| `http://…` or `https://…` | Starts with `http` | Direct HTTP GET |
| `swagger/v1/swagger.json` | No `://`, no leading `.` or `/`, no local file match | Relative URL — prepend `BASE_URL` from env |
| `./specs/foo.json`, `specs/foo.json` | Local file exists at resolved path | `readFileSync` |

**Relative URL resolution:** `BASE_URL` is read from the loaded env file (same `--env` flag / `defaults.env` fallback as `shogun run`). The spec is fetched as `{BASE_URL}/{spec.path}`.

If a relative path is configured and no env is available and the path doesn't exist as a local file, the command exits with:

```
Error: Cannot resolve spec source "swagger/v1/swagger.json".
  No local file found at that path, and BASE_URL is not set.
  Options:
    • Pass --env <name> to load BASE_URL from an env file
    • Use a full URL: shogun spec http://localhost:5000/swagger/v1/swagger.json
    • Use a local file: shogun spec specs/enigma-api.json
```

---

## Configuration

### `shogun.config.yaml` — New `spec` Section

```yaml
version: 1
# ... existing config ...
spec:
  path: swagger/v1/swagger.json   # route to live OpenAPI JSON on the target server
                                  # fetched as: {BASE_URL}/swagger/v1/swagger.json
```

The `path` is the **server-relative route** where the running API serves its OpenAPI JSON. It is combined at runtime with `BASE_URL` from the loaded env file — no local copy needed.

`BASE_URL` is already required by every test collection (it's the API base), so no new env var is introduced.

When `spec` is not present in config, the user must provide the source as the first positional argument. If neither is provided, the command exits with a clear error:

```
Error: No spec source. Set spec.path in shogun.config.yaml or pass a source as the first argument.
  Examples:
    shogun spec --env local --endpoint /api/workspaces
    shogun spec http://localhost:5000/swagger/v1/swagger.json --endpoint /api/workspaces
    shogun spec specs/enigma-api.json --endpoint /api/workspaces   # local file fallback
```

---

## Output Format: `pretty` (default)

The goal is a concise, immediately useful block that costs minimal tokens. Example output for `shogun spec --endpoint /api/code/checkpoints --method POST`:

```
────────────────────────────────────────────────────────
POST /api/code/checkpoints
Tag:     Code
Summary: Create a checkpoint of the current workspace state

Parameters (query):
  • workspaceName  string  (required)  Workspace to snapshot

Request Body (application/json):  CheckpointCreateRequest
  • label    string   (optional)  Human-readable label for the checkpoint
  • message  string   (optional)  Commit message

Responses:
  200  OK
────────────────────────────────────────────────────────
```

**Key behaviors:**
- All `$ref` schema references are **resolved inline** — the agent never has to chase refs manually
- Nullable fields are marked `(nullable)`
- Required fields are marked `(required)`
- Enum values are shown inline: `status  string  enum: [pending, running, done]`
- If the endpoint has multiple methods, they are printed as separate blocks separated by a divider

---

## Output Format: `--list`

When no filter is given (or `--list` is explicit), output mirrors the summary file but live from the spec:

```
Endpoints (226 total):
  GET    /api/agents
  POST   /api/agents
  GET    /api/agents/catalog
  ...
  
Use --tag, --endpoint, --method, or --search to drill in.
```

---

## Output Format: `--tag <name>`

```
Agents (22 endpoints):
  GET    /api/agents                          List all agents
  POST   /api/agents                          Spawn an ephemeral named agent
  GET    /api/agents/catalog                  List all agent catalog definitions
  ...
```

---

## Output Format: `--schema <name>`

```
Schema: AgentDefinition
  name          string   (required)
  image         string   (required)
  command       string   (nullable)
  args          array<string>  (nullable)
  env           object{...}  (nullable)
  workingDir    string   (nullable)
```

---

## $ref Resolution

The spec contains `$ref: "#/components/schemas/AgentDefinition"` pointers throughout. The command **must inline these**. A naive implementation that shows raw `$ref` strings is useless to an agent.

Resolution rules:
1. Walk the path entry's `requestBody.content.application/json.schema`
2. If it is a `$ref`, look it up under `components.schemas`
3. Expand the schema's `properties` recursively (up to 2 levels deep to avoid explosion on circular/deeply nested schemas)
4. Mark `required` fields from the schema's `required` array

---

## Implementation Plan

### Files to Create

| File | Role |
|------|------|
| [`src/commands/spec.ts`](../../src/commands/spec.ts) | Spec command implementation |

### Files to Modify

| File | Change |
|------|--------|
| [`src/index.ts`](../../src/index.ts) | Register `spec` case in switch, add to USAGE, add spec-related args to `parseArgs` |
| [`src/loader.ts`](../../src/loader.ts) | Add `fetchSpec()` function (URL + file); add `spec` section to `ShogunConfigSchema` |
| [`src/types.ts`](../../src/types.ts) | Add `SpecConfig` interface to `ShogunConfig` |
| [`agents.md`](../../agents.md) | ✅ Done — Key Signposts + Key CLI Commands updated |
| [`local-dev-test-repo/shotgun.config.yaml`](../../local-dev-test-repo/shotgun.config.yaml) | Add `spec.path: swagger/v1/swagger.json` |
| [`.agents/skills/shogun-test-writer.md`](../../.agents/skills/shogun-test-writer.md) | ✅ Done — `shogun spec` added to triage protocol |

---

## Data Flow

```mermaid
flowchart TD
    A[shogun spec ...args] --> B{positional spec-source?}
    B -- yes --> C{source type?}
    B -- no --> D[load shogun.config.yaml → spec.path]
    D --> E{spec.path set?}
    E -- no --> ERR1[exit 1: no spec source]
    E -- yes: relative route --> F[load env file → read BASE_URL]
    C -- http/https full URL --> FETCH[HTTP GET full URL]
    C -- relative route --> F
    C -- local file exists --> FILE[readFileSync]
    F --> G{BASE_URL available?}
    G -- no --> ERR2[exit 1: BASE_URL not set — pass --env]
    G -- yes --> FETCH2[HTTP GET BASE_URL/path]
    FETCH --> PARSE[parse JSON]
    FETCH2 --> PARSE
    FILE --> PARSE
    PARSE --> I{filter flags?}
    I -- --endpoint + --method --> J[paths filter → method slice]
    I -- --endpoint only --> K[paths filter → all methods]
    I -- --tag --> L[filter paths by tag membership]
    I -- --schema --> M[components.schemas lookup]
    I -- --search --> N[full-text scan of summaries]
    I -- none / --list --> O[list all paths]
    J & K & L --> P[resolve dollar-refs inline]
    P --> Q[format output]
    M --> Q
    N --> Q
    O --> Q
    Q --> R[stdout]
```

---

## Agent Workflow Integration

The `shogun-test-writer.md` skill should be updated to include a **mandatory triage step** before concluding any failure is a test bug:

```markdown
## Step N — Confirm API Contract Before Concluding "Test Bug"

Before fixing a test, run:
  shogun spec --endpoint <path> --method <method>

Compare the contract against what the test is asserting. If the spec says:
- The parameter is optional but the test asserts it's required → likely a test bug
- The spec says 200 OK but the test gets 422 → investigate whether the API has changed
- The spec shows a schema field the response doesn't return → likely an API bug
```

---

## Acceptance Criteria

### Fetch behavior
- [ ] `shogun spec --env local --endpoint /api/workspaces --method GET` fetches `{BASE_URL}/swagger/v1/swagger.json` and returns only the GET block with inline schema
- [ ] `shogun spec http://localhost:5000/swagger/v1/swagger.json --endpoint /api/workspaces` uses the full URL directly without needing `--env`
- [ ] `shogun spec specs/enigma-api.json --endpoint /api/workspaces` reads from local file (offline fallback)
- [ ] When `spec.path` + `defaults.env` are both in `shogun.config.yaml`, running `shogun spec --endpoint /api/workspaces` works with no extra flags
- [ ] Missing spec source → exit 1 with helpful message showing all three forms
- [ ] Relative path configured + no env + no local file → exit 1 with message explaining `--env` is needed
- [ ] HTTP fetch failure (non-200, network error) → exit 1 with URL + status code in error message

### Query behavior
- [ ] `shogun spec --tag Agents` returns all Agents-tagged endpoints in compact form
- [ ] `shogun spec --schema AgentDefinition` resolves and prints the schema with `$refs` inlined
- [ ] `shogun spec --search checkpoint` returns all endpoints whose summary/description contain "checkpoint"
- [ ] `shogun spec --list` emits one line per endpoint: `METHOD  /path  summary`
- [ ] `shogun spec --format json` emits valid JSON of the raw filtered OpenAPI slice

### Output correctness
- [ ] All `$ref` chains are resolved — no raw `"$ref"` strings appear in pretty output
- [ ] Required fields marked `(required)`, nullable fields marked `(nullable)`
- [ ] The command appears in `shogun --help`

---

## Out of Scope (Future Stories)

- **Diff mode**: `shogun spec --diff` — compare two spec versions to catch breaking changes between deployments
- **Validate mode**: cross-reference the spec against existing test files to find untested endpoints
- **YAML format OpenAPI**: support `.yaml` OpenAPI specs in addition to `.json`
