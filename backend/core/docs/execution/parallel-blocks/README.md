# Parallel Block Handoff

> Authority: `GrowthOS-外链板块AI分步Coding指令手册-V1.4-并行板块执行补丁-2026-07-27.md`
> Canonical state owner: integration controller only

## Rules

- A block conversation works in one isolated physical workspace.
- It executes one original `BL-AI-*` task at a time.
- It does not edit `backlinks-ai-coding-state.md`.
- It does not edit integration-owned files.
- It does not mark a task `DONE`.
- It writes one result file named `<block-id>-result.md`.
- `HANDOFF_READY` means the block-local implementation and tests are ready for integration; it is not product acceptance.

## PB-LIVE-ACTIVATION Exception

`PB-LIVE-ACTIVATION` is a post-RC block, not an original `BL-AI-*` development
block. It follows these stricter rules:

- It starts only after `BL-AI-197 = DONE`.
- It runs in the controlled integration/Canary environment, one `LIVE-*` task
  at a time, strictly as `LIVE-001 -> LIVE-002 -> LIVE-003 -> LIVE-004 ->
  LIVE-005 -> LIVE-006 -> LIVE-GATE`, as defined by
  `10-PB-LIVE-ACTIVATION.md`.
- Every task requires separate explicit user authorization.
- It may update Canonical State only with exact live evidence and must never
  treat task registration as Provider, credential, budget, or production
  authorization.
- Its result file is `PB-LIVE-ACTIVATION-result.md`; the final Gate is
  `PASS_CONTROLLED_LIVE_CANARY` or `NO_GO`, not generic product acceptance.

## Result Template

```markdown
# <BLOCK-ID> Result

Status: HANDOFF_READY | BLOCKED
Workspace: <absolute path>
Baseline date: 2026-07-27
Task: <one original task ID>

## Scope

- Single objective:
- Allowed paths checked:
- Prohibited paths touched: none | <list>

## Changed Files

- <exact path>

## Verification

| Command | Exit code | Result |
|---|---:|---|
| `<command>` | `0` | `<passed count or evidence>` |

## Shared Change Requests

- Public FastAPI/OpenAPI:
- Fastify route registration:
- Temporal/event registry:
- Migration manifest/PostgreSQL gate:
- Dependency/NOTICE/SBOM:
- Frontend registration/global client:

## External Effects

- Real network:
- Credentials:
- Persistent database:
- Production resource:
- Git commit/push:

## Unverified

- <explicit limitation>
```

## Integration Controller Checklist

1. Confirm the task belongs to the block.
2. Confirm changed paths stay inside the block allowlist.
3. Import one block at a time.
4. Apply shared change requests in the integration root.
5. Run block-local and shared regressions.
6. Run PostgreSQL 18 gates for migrations.
7. Compare protected frontend hashes for frontend work.
8. Update canonical Coding State only after integration passes.
