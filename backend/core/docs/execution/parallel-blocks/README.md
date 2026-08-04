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
