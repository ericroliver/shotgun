# Product Story: VC Collection — Full TOVC Lifecycle Test Suite

**Epic:** `api-testapp-1` coverage expansion  
**Collection:** `vc`  
**Suite:** `api-testapp-1` only  
**Testing plan:** [`local-dev-test-repo/testing-plans/vc.md`](../../local-dev-test-repo/testing-plans/vc.md)

---

## Why

Version control is the beating heart of Enigma's TOVC (Task-Oriented Version Control) capability.
Every agent-driven code change flows through this pipeline: task → worktree → checkpoint → submission → integration.
None of it was under automated test. If the VC API breaks, the entire agentic workflow breaks silently.

This story adds a comprehensive, self-resetting test collection that exercises the full TOVC lifecycle
end-to-end on every run.

---

## What

A single `vc` collection (`local-dev-test-repo/tests/collections/vc/`) with 24 test files covering
all 23 VC API endpoints. The collection lifecycle is:

```
Setup: create fresh task (isolated git worktree)
  ├─ Phase 1:  Task reads
  ├─ Phase 2:  Workspace reads (7 endpoints)
  ├─ Phase 3:  Checkpoint lifecycle (create → get → list → restore)
  ├─ Phase 4:  Workspace mutations (clean, revert, reset)
  ├─ Phase 5:  Submission path A — finalize
  ├─ Phase 6:  Integration apply (gated, off by default)
  ├─ Phase 7:  Submission path B — abandon
  └─ Phase 8:  Cleanup (delete checkpoint, delete task)
Teardown: safety-net force-delete of task worktree
```

The task worktree is the environment reset: creating it gives a clean slate; destroying it
(`force=true`) leaves no residue. No main workspace is touched. No production branch is modified
(integration apply is off by default).

---

## Acceptance Criteria

- [ ] All 24 test files exist under `tests/collections/vc/`
- [ ] `_collection.yaml` has correct `order:`, `setup:`, and `teardown:` scripts
- [ ] Collection setup creates a VC task and asserts `taskId` + `workspaceId` were stashed
- [ ] Teardown force-deletes the task even when tests fail mid-run
- [ ] `get-vc-tasks` passes on a clean run (list may be empty)
- [ ] `post-vc-task` creates a task and stashes `createdTaskId` + `createdWorkspaceId`
- [ ] All 7 workspace read tests pass (changes/diff/impact/conflicts/checkpoints/workspace/metadata)
- [ ] `post-vc-checkpoint` creates checkpoint and stashes `createdCheckpointId`
- [ ] `post-vc-checkpoint-restore` passes (git reset --hard to our checkpoint)
- [ ] `post-vc-workspace-clean` / `post-vc-workspace-revert` / `post-vc-workspace-reset` all pass
- [ ] `post-vc-submission-a` + `post-vc-submission-finalize` complete the finalize path
- [ ] `post-vc-submission-b` + `post-vc-submission-abandon` complete the abandon path
- [ ] `post-vc-integration-apply` is **skipped** (no assertion fail) when `VC_INTEGRATION_ENABLED` ≠ `true`
- [ ] `post-vc-integration-apply` + `get-vc-integration` pass when `VC_INTEGRATION_ENABLED=true`
- [ ] `delete-vc-checkpoint` passes (200 or 404 accepted — may already be gone)
- [ ] `delete-vc-task?force=true` passes and clears `ctx.vars.createdTaskId`
- [ ] `vc` is added to `tests/suites/api-testapp-1.yaml` collections list
- [ ] `VC_TARGET_BRANCH` and `VC_INTEGRATION_ENABLED` are documented in `envs/local.env.example`
- [ ] Full suite run exits zero with no leaked tasks on the server

---

## Test File Inventory

| File | Method | Path | Notes |
|------|--------|------|-------|
| `get-vc-tasks.yaml` | GET | `/api/vc/tasks` | List; snapshot:true |
| `post-vc-task.yaml` | POST | `/api/vc/tasks` | Creates worktree; stashes taskId+workspaceId |
| `get-vc-task.yaml` | GET | `/api/vc/tasks/{taskId}` | Reads back created task |
| `get-vc-workspace.yaml` | GET | `/api/vc/workspaces/{workspaceId}` | |
| `get-vc-workspace-changes.yaml` | GET | `/api/vc/workspaces/{workspaceId}/changes` | |
| `get-vc-workspace-diff.yaml` | GET | `/api/vc/workspaces/{workspaceId}/diff` | |
| `get-vc-workspace-impact.yaml` | GET | `/api/vc/workspaces/{workspaceId}/impact` | |
| `get-vc-workspace-conflicts.yaml` | GET | `/api/vc/workspaces/{workspaceId}/conflicts` | Requires `?target={branch}` |
| `post-vc-checkpoint.yaml` | POST | `/api/vc/checkpoints` | Stashes checkpointId |
| `get-vc-checkpoint.yaml` | GET | `/api/vc/checkpoints/{checkpointId}` | |
| `get-vc-workspace-checkpoints.yaml` | GET | `/api/vc/workspaces/{workspaceId}/checkpoints` | |
| `post-vc-checkpoint-restore.yaml` | POST | `/api/vc/checkpoints/{checkpointId}/restore` | ⚠️ git reset --hard |
| `post-vc-workspace-clean.yaml` | POST | `/api/vc/workspaces/{workspaceId}/clean` | |
| `post-vc-workspace-revert.yaml` | POST | `/api/vc/workspaces/{workspaceId}/revert` | `{mode:"all"}` |
| `post-vc-workspace-reset.yaml` | POST | `/api/vc/workspaces/{workspaceId}/reset` | `{target:null}` |
| `post-vc-submission-a.yaml` | POST | `/api/vc/submissions` | Stashes submissionIdA |
| `get-vc-submission.yaml` | GET | `/api/vc/submissions/{submissionIdA}` | |
| `post-vc-submission-finalize.yaml` | POST | `/api/vc/submissions/{submissionIdA}/finalize` | |
| `post-vc-integration-apply.yaml` | POST | `/api/vc/integrations/apply` | ⚠️⚠️ Gated — off by default |
| `get-vc-integration.yaml` | GET | `/api/vc/integrations/{integrationId}` | Skipped if apply was gated |
| `post-vc-submission-b.yaml` | POST | `/api/vc/submissions` | Stashes submissionIdB |
| `post-vc-submission-abandon.yaml` | POST | `/api/vc/submissions/{submissionIdB}/abandon` | |
| `delete-vc-checkpoint.yaml` | DELETE | `/api/vc/checkpoints/{checkpointId}` | |
| `delete-vc-task.yaml` | DELETE | `/api/vc/tasks/{taskId}?force=true` | ⚠️ Destroys worktree |

---

## Risk Flags

### 🔴 `POST /api/vc/integrations/apply`

**This endpoint writes to a real git branch.** The `ApplyIntegrationRequest.target` field names
the branch. In a shared dev server, writing to `main` would corrupt the reference workspace for
all other tests.

**Mitigation:**
- The test is gated behind `VC_INTEGRATION_ENABLED=true` in `local.env`
- Default is `false` — the test soft-skips using a sentinel var and does not fail the run
- When enabled, the implementer must ensure `VC_TARGET_BRANCH` points to a throwaway branch,
  not `main` or any branch used by snapshot baselines

### ⚠️ `POST /api/vc/checkpoints/{checkpointId}/restore`

Does `git reset --hard` on the worktree. Safe because:
- The `workspaceId` is scoped to our own test task's isolated worktree
- The checkpoint was created by us seconds earlier in the same test run
- Even if the restore fails, teardown destroys the entire worktree

### ⚠️ `DELETE /api/vc/tasks/{taskId}?force=true`

The `force` query param is **required** by the API spec. Always append `?force=true`.
The test must assert `ctx.vars.createdTaskId` is set before building the request path to
prevent accidentally deleting the wrong task.

---

## Variables flow diagram

```
_collection.yaml setup
  └─ POST /api/vc/tasks
       ├─ ctx.vars.createdTaskId      ──────────────────────────────────────┐
       └─ ctx.vars.createdWorkspaceId ──────────┐                          │
                                                │                          │
    get-vc-workspace*  (all 6 workspace tests)  │                          │
       pre: ctx.request.path = /api/vc/workspaces/${workspaceId}/...       │
                                                │                          │
    post-vc-checkpoint                                                     │
       pre: body.workspaceId = ctx.vars.createdWorkspaceId                 │
       post: ctx.vars.createdCheckpointId ────────────────────┐            │
                                                              │            │
    get-vc-checkpoint, post-vc-checkpoint-restore             │            │
       pre: path uses ctx.vars.createdCheckpointId ◄──────────┘            │
                                                                           │
    post-vc-submission-a                                                   │
       post: ctx.vars.submissionIdA ──────────────────────┐                │
                                                          │                │
    get-vc-submission, post-vc-submission-finalize        │                │
       pre: path uses ctx.vars.submissionIdA ◄────────────┘                │
                                                                           │
    post-vc-integration-apply                                              │
       post: ctx.vars.createdIntegrationId ───────────────┐                │
    get-vc-integration                                    │                │
       pre: path uses ctx.vars.createdIntegrationId ◄─────┘                │
                                                                           │
    post-vc-submission-b → post-vc-submission-abandon                      │
                                                                           │
    delete-vc-task                                                         │
       pre: path = /api/vc/tasks/${taskId}?force=true ◄────────────────────┘
       post: ctx.vars.createdTaskId = null (prevents teardown double-delete)

_collection.yaml teardown
  └─ if ctx.vars.createdTaskId → force-delete (safety net)
```

---

## Env vars to add to `local.env.example`

```bash
# ── VC (Version Control) collection ──────────────────────────────────────────
# Branch used for the dry-run conflict check (GET .../conflicts?target=)
VC_TARGET_BRANCH=main

# Set to "true" ONLY on a dev instance where it is safe to write to the target branch.
# When false (default), post-vc-integration-apply is silently skipped (not failed).
VC_INTEGRATION_ENABLED=false
```

---

## Suite file change

**`tests/suites/api-testapp-1.yaml`** — add `vc` to the `collections:` list:

```yaml
collections:
  - workspace-backup
  - code
  - fs
  - deps
  - vc          # ← add this line
```

---

## Implementation notes for the builder

1. **`workspaceId` extraction from task response** — the spec gives no body schema. The setup
   script tries the four most likely shapes. After the first real run, check the actual response
   in the run log and lock down the stash expression.

2. **Two submissions required** — `finalize` and `abandon` are mutually exclusive terminal states
   on a single submission. The plan creates `submissionIdA` (finalize path) and `submissionIdB`
   (abandon path) independently. Do not attempt to finalize then abandon the same submission ID.

3. **Checkpoint before restore** — the checkpoint restore test operates on the checkpoint created
   in `post-vc-checkpoint`. Order matters. The collection `order:` enforces this but the pre-script
   should also assert `ctx.vars.createdCheckpointId` is non-null.

4. **`force=true` query param** — the OpenAPI spec marks `force` as a **required** parameter on
   `DELETE /api/vc/tasks/{taskId}`. Without it, the API will likely return 4xx. Always use
   `ctx.request.path = \`/api/vc/tasks/${id}?force=true\``.

5. **Integration apply sentinel pattern** — since `ctx.skip()` does not exist, the integration
   apply test uses `ctx.vars.vcIntegrationSkipped = true` set in `pre:` when the gate is off.
   The `post:` script checks this var and logs "SKIPPED (gate off)" instead of asserting.
   The test will show as `passed` with a skip log message — this is correct behaviour.

6. **`get-vc-tasks` snapshot** — this is the only `snapshot: true` test in the collection.
   Run `shogun snapshot --collection vc --env local` after the first successful run to capture
   the baseline. The list should be stable (only contains our test task which is deleted at end).
   Use `ignore_fields: ["**.createdAt", "**.updatedAt", "**.id", "**.taskId"]` to avoid volatility.
   Actually, since task IDs are volatile, consider `snapshot: false` and shape-only assertions.
   Revisit after seeing the actual response shape.
