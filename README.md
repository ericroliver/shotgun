# shogun

> Shell-first API testing with YAML test definitions, TypeScript scripting, and snapshot diffing.

## **NOTICE: This project was completely written using agentic development tools.**

Shogun executes HTTP requests via `curl`, validates responses with `jq`, and diffs snapshots with `diff`. TypeScript handles test orchestration, pre/post hooks, and run logging. No HTTP client libraries. No heavy test frameworks.

---

## Installation

### Option 1 — npm (recommended)

```bash
npm install -g shogun
shogun --version
```

### Option 2 — npx (zero install, great for CI)

```bash
npx shogun --version
npx shogun run --env QA
```

### Option 3 — Standalone binary (no Node.js required)

Download a prebuilt binary from the [Releases page](https://github.com/your-org/shogun/releases):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/your-org/shogun/releases/latest/download/shogun-macos-arm64 \
  -o /usr/local/bin/shogun && chmod +x /usr/local/bin/shogun

# Linux x64
curl -L https://github.com/your-org/shogun/releases/latest/download/shogun-linux-x64 \
  -o /usr/local/bin/shogun && chmod +x /usr/local/bin/shogun
```

---

## Requirements

| Tool | Notes |
|------|-------|
| Node.js ≥ 20 | Not required for standalone binary |
| `curl` | HTTP execution |
| `jq` | Shape assertions and snapshot normalization |
| `diff` | Snapshot comparison |

**macOS:** `jq` is available via `brew install jq`.
**Ubuntu/Debian:** `apt install jq curl`.

---

## How It Works

1. You create a **test repo** — a directory with `shogun.config.yaml`, `envs/`, and `tests/collections/`
2. Each test is a YAML file describing a request, expected status, optional shape assertions, and optional TypeScript pre/post scripts
3. `shogun run` discovers collections, fires requests via `curl`, and asserts the results
4. First run captures snapshot baselines in `expected/` (committed to git)
5. Subsequent runs diff actual responses against baselines — any change is a failure

---

## Getting Started

### 1. Create your test repo

```bash
mkdir my-api-tests && cd my-api-tests
```

### 2. Create `shogun.config.yaml`

```yaml
version: 1
defaults:
  env: local
  timeout: 10
paths:
  tests: ./tests
  envs: ./envs
  expected: ./expected
  runs: ./runs
ignore_fields_global:
  - "**.timestamp"
  - "**.requestId"
```

### 3. Create an environment file

```bash
mkdir envs
cat > envs/local.env << 'EOF'
BASE_URL=http://localhost:8080
AUTH_TOKEN=Bearer your-dev-token
TIMEOUT=10
EOF
```

### 4. Write your first test

```bash
mkdir -p tests/collections/system
cat > tests/collections/system/health.yaml << 'EOF'
name: System Health Check
tags:
  - smoke

request:
  method: GET
  path: /api/health

response:
  status: 200
  snapshot: true
  shape:
    - 'has("status")'
    - '.status == "healthy"'
EOF
```

### 5. Capture baseline and run

```bash
# First: capture the expected response as a baseline
shogun snapshot --env local

# Then run — diffs against the baseline
shogun run --env local
```

---

## Project Structure (your test repo)

```
my-api-tests/
├── shogun.config.yaml          # Global config
│
├── envs/                       # One file per environment
│   ├── local.env.example       # Committed template
│   ├── local.env               # Gitignored — real values
│   ├── QA.env                  # Gitignored
│   └── staging.env             # Gitignored
│
├── tests/
│   ├── collections/
│   │   ├── agents/             # One directory per collection
│   │   │   ├── _collection.yaml    # Order, setup/teardown hooks
│   │   │   ├── get-agents.yaml
│   │   │   ├── create-agent.yaml
│   │   │   └── delete-agent.yaml
│   │   └── system/
│   │       ├── _collection.yaml
│   │       └── health.yaml
│   ├── suites/
│   │   └── smoke.yaml          # Named multi-collection run
│   └── fixtures/               # Shared request body JSON files
│
├── expected/                   # Snapshot baselines — committed to git
│   ├── agents/
│   └── system/
│
└── scripts/                    # Shared TypeScript helpers
    ├── auth.ts                 # e.g. token refresh helpers
    └── transforms.ts           # e.g. response normalizers
```

> `runs/` is generated at runtime and gitignored.

---

## Environment Files

Select an environment with `--env`:

```bash
shogun run --env QA
shogun run --env QA-2
shogun run              # defaults to "local"
```

Variables are available in YAML as `${VAR_NAME}` interpolation and in scripts as `ctx.env.VAR_NAME`.

**Minimum variables:**

| Variable | Purpose |
|----------|---------|
| `BASE_URL` | Base URL for all requests (required) |
| `AUTH_TOKEN` | Injected as `Authorization` header if set |
| `TIMEOUT` | Request timeout in seconds (default: 10) |

---

## Test Definition Format

```yaml
name: Get All Agents
description: Returns the paginated agent list
collection: agents
tags:
  - smoke
  - readonly

# Optional: per-test env overrides
env:
  TIMEOUT: 30

# TypeScript — runs before curl; can mutate ctx.request
pre: |
  ctx.request.headers['X-Request-Source'] = 'shogun';

request:
  method: GET
  path: /api/agents
  headers:
    Accept: application/json
  params:
    limit: 20
    offset: 0

response:
  status: 200                   # Assert HTTP status code

  snapshot: true                # Diff against expected/ baseline
  ignore_fields:                # Strip these before diffing
    - "**.id"
    - "**.timestamp"

  # jq boolean expressions — each must evaluate truthy
  shape:
    - 'has("agents")'
    - '.agents | type == "array"'
    - 'has("total")'

# TypeScript — runs after assertions; has ctx.response
post: |
  ctx.assert(Array.isArray(ctx.response.body.agents), '"agents" must be array');
  ctx.vars.agentCount = ctx.response.body.total;
  ctx.log(`Found ${ctx.response.body.total} agents`);
```

---

## Collections

A collection is a directory under `tests/collections/` with an optional `_collection.yaml`:

```yaml
name: Agents API
order:
  - get-agents
  - create-agent
  - get-agent-by-name
  - delete-agent

# Runs once before first test — ctx.vars available to all tests
setup: |
  ctx.vars.testAgentName = `shogun-${Date.now()}`;
  ctx.log(`Test agent: ${ctx.vars.testAgentName}`);

# Runs once after last test — even if tests fail
teardown: |
  if (ctx.vars.createdAgentName) {
    await ctx.http.delete(`/api/agents/${ctx.vars.createdAgentName}`);
  }
```

---

## Suites

Run a named subset of collections:

```yaml
# tests/suites/smoke.yaml
name: Smoke Suite
collections:
  - system
  - agents
tags:
  - smoke
```

```bash
shogun run --suite smoke
```

---

## Snapshots

Snapshots compare the actual response body against a saved baseline file in `expected/`. Volatile fields (timestamps, IDs) are stripped before comparison using `ignore_fields`.

```bash
# Capture baselines — writes expected/ files (commit these)
shogun snapshot --env QA

# Update a single test's baseline
shogun snapshot --file tests/collections/agents/get-agents.yaml

# Normal run — diffs against committed baselines
shogun run --env QA
```

On first run with `snapshot: true` and no baseline, the test is marked **needs_baseline** rather than failing.

---

## Run Logs

Every run produces a timestamped directory under `runs/`:

```
runs/20260328_200532/
  summary.json                      # Overall results
  agents--get-all-agents.log        # Per-test detail
```

```bash
shogun report                       # Latest run
shogun report --run 20260328_200532 # Specific run
shogun report --format json         # JSON output
```

---

## Pre/Post Script Context (`ctx`)

Scripts are inline TypeScript, executed via `tsx`. They receive a `ShogunContext` object:

```typescript
ctx.env                  // env vars — read only
ctx.vars                 // mutable store, persists across tests in a run
ctx.request              // current request — mutable in pre-script
ctx.response             // current response — available in post-script

ctx.assert(bool, msg)    // throws and fails test if bool is false
ctx.log(msg)             // write to stdout and run log

// Additional HTTP calls (for setup/teardown/chaining)
await ctx.http.get('/api/something')
await ctx.http.post('/api/agents', { name: 'test' })
await ctx.http.delete('/api/agents/test')

// Shared helpers from scripts/
ctx.scripts.auth.getBearerToken(ctx.env)
ctx.scripts.transforms.stripVolatileFields(ctx.response.body)
```

Scripts support `async/await`. Auth tokens are automatically redacted in all log output.

---

## CLI Reference

```
shogun run                            Run all tests (default env)
shogun run --env <name>               Select environment (e.g. QA, staging)
shogun run --collection <name>        Run one collection
shogun run --tags <tag1,tag2>         Filter by tags (comma-separated)
shogun run --suite <name>             Run a named suite
shogun run --file <path>              Run a single test file
shogun run --format json              JSON output (for CI pipelines)
shogun run --format tap               TAP output

shogun snapshot                       Capture/update all baselines
shogun snapshot --env <name>          Snapshot against specific environment
shogun snapshot --file <path>         Update single test baseline

shogun report                         Show latest run report
shogun report --run <timestamp>       Show specific run
shogun report --format json           JSON output

shogun lint                           Validate all YAML files (no HTTP)
shogun lint --file <path>             Validate single file

shogun --version
shogun --help
```

**Exit codes:** `0` = all tests passed. `1` = one or more failures (suitable for CI gate).

---

## CI Integration

```yaml
# GitHub Actions example
- name: Run API smoke tests
  run: npx shogun run --env QA --suite smoke --format json
  env:
    BASE_URL: ${{ secrets.QA_BASE_URL }}
    AUTH_TOKEN: ${{ secrets.QA_AUTH_TOKEN }}
```

Shogun reads env vars from both the `.env` file and `process.env`, so CI secrets can be injected directly without a file.
