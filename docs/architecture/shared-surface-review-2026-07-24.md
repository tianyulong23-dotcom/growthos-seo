# Shared Surface Review - 2026-07-24

## Decision

Review ID: `BL-AI-ARCH-008-FU-001`

Decision date: `2026-07-24`

Repository-local assignee identifier: `tianyulong23-dotcom`

Authorization basis: the repository operator explicitly instructed completion
of `BL-AI-ARCH-008-FU-001` through `004` followed by a rerun of the
`BL-AI-ARCH-008` gate. This record does not claim authenticated GitHub account
ownership, independent reviewers, a merge, a commit, or a push.

## Approved Roles

| Role | Approved responsibility in this change |
|---|---|
| `ROLE-PLATFORM-API` | FastAPI Gateway adapter, configuration, and runtime tests |
| `ROLE-PLATFORM-CONTEXT` | Signed `PlatformRequestContext.v1` production and project binding |
| `ROLE-PLATFORM-CONTRACTS` | Aggregate OpenAPI unavailable response and contract checks |
| `ROLE-PLATFORM-FRONTEND` | Confirm that the browser retains one public Gateway base and receives no private service address |
| `ROLE-BACKLINKS` | Private Fastify bootstrap, route registration, and module-stop behavior |
| `ROLE-ARCHITECTURE` | Follow-up scope, compatibility classification, and final gate decision |
| `ROLE-AUDIT` | Test-only non-Backlinks availability probe used by the isolation harness |

All roles above are assigned to `tianyulong23-dotcom` for this repository-local
change. One assignee holding multiple roles is recorded explicitly and is not
represented as independent review.

## Approved Paths

- `docs/architecture/shared-module-ownership.md`
- `docs/architecture/shared-surface-review-2026-07-24.md`
- `backend/api/app/**`
- `backend/api/tests/**`
- `backend/api/scripts/**`
- `backend/api/pyproject.toml`
- `backend/api/uv.lock`
- `backend/contracts/openapi/platform.v1.json`
- `backend/core/src/index.ts`
- `backend/core/src/modules/backlinks/api/**`
- `backend/core/test/backlinks/api/**`
- `backend/core/test/backlinks/runtime/**`
- `backend/core/package.json`
- `backend/core/docs/execution/backlinks-ai-shared-repo-compatibility.md`
- `backend/core/docs/execution/backlinks-ai-coding-state.md`

No frontend source path is approved for modification. The frontend role review
is limited to verifying that existing browser transport still points only at
the Platform Gateway.

## Conflict Handling

The worktree was already dirty before this review. Existing modifications and
untracked files are preserved. Each follow-up edit must be limited to the paths
above, must not overwrite unrelated work, and must not use destructive Git
commands.

## Required Verification

Approval was conditional on all of the following:

1. Backlinks Core typecheck, lint, API tests, contract tests, and private
   runtime bootstrap tests pass.
2. Platform Gateway Ruff, unit tests, shared contract checks, and all seven
   runtime adapter route checks pass.
3. A disposable cross-process isolation test proves Platform health and a
   non-Backlinks module remain available after Backlinks stops.
4. Backlinks requests return the agreed unavailable problem without a fallback
   writer, duplicate public route, or retry.
5. Frontend typecheck, lint, build, and one-public-base scan pass.
6. No paid provider, Gmail, AI, production database, supplied credential,
   commit, or push is used.

## Verification Result

All required verification passed on `2026-07-24`:

- Backlinks Core typecheck and lint passed; API `46/46`, Contract `49/49`,
  private bootstrap `3/3`, and PostgreSQL-enabled Integration `77/77` passed.
- Platform Gateway Ruff passed; pytest passed `11/11`; the shared contract
  checker reported 8 public paths, 0 cross-module events, and 1 module Task
  Queue.
- The disposable shared runtime registered 7 Gateway routes and executed one
  Backlinks command. After Backlinks stopped, Platform health and the
  test-only Audit probe remained `200`; Backlinks returned exact
  `503 BACKLINKS_UNAVAILABLE`.
- Frontend typecheck, lint, and build passed; one `VITE_API_BASE_URL`, one
  direct `fetch`, and no private Backlinks browser base were found.
- No paid provider, Gmail, AI, production database, supplied credential,
  commit, or push was used.

The conditional approval is therefore satisfied for this repository-local
change and authorizes `SHARED-REPO-GATE = PASS`. It does not claim independent
review, authenticated GitHub ownership, persistent deployment, or production
E2E evidence.
