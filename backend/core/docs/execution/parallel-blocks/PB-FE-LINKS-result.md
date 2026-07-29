# PB-FE-LINKS Result

Task: `BL-AI-159`
Status: `HANDOFF_READY`
Date: `2026-07-29`
Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo`

## Delivered

- Preserved and extended `frontend/src/features/outreach/links/**`.
- Implemented separate Candidate, Confirmed, Changed, Lost, and Recovered
  seek-paginated views. Candidate remains explicitly outside successful KPI
  calculations and is never rendered as a successful state.
- Matched the re-frozen public Links DTOs and operations:
  list, Candidate detail, Placement detail, Placement lifecycle events,
  immutable evidence read, and Placement reverify.
- Placement detail renders first validation, latest server Observation, server
  evidence freshness including `stale`, lifecycle/recovery events, and the
  server-reported monitor job state including `job-running`.
- Immutable evidence is read only through the evidence identifier returned by
  the server. The screen renders server-provided immutable/hash-verification
  fields and does not fabricate evidence.
- Reverify sends the current server Placement version and a generated
  idempotency key to the frozen command. Authorization is left to the server;
  `403`, `404`, `409`, and generic failure are non-success command states.
  The client does not invoke a Browser worker or fetch publisher pages.
- Explicit UI states exist for loading, empty, error, forbidden, conflict,
  stale, and job-running. Detail/event/evidence/command failures remain
  unknown rather than being inferred as a successful or Lost state.

## Scope And Boundaries

- Changed only `frontend/src/features/outreach/links/**` plus this result
  record.
- Did not edit either protected workspace:
  `frontend/src/features/outreach/placement-monitoring-workspace.tsx` or
  `frontend/src/features/outreach/outreach-workspace.tsx`.
- Did not change backend, DataForSEO, Canonical State, global CSS, navigation,
  or another page. No commit, push, or BL-AI-160 work was performed.
- `manual-preview.*` is a DTO-shaped local fixture for feature verification.
  It is not an API registration and made no live Gateway, Core, provider,
  Browser-worker, or production call.

## Shared Change Request

No protected workspace was modified in this block. When the owning workspace
task wires Links into the outreach surface, it must mount `LinksWorkspace` and
pass the project key/client at that owner boundary, replacing any hard-coded
Links/placement presentation there. This block supplies no unauthorized
integration change.

## Verification Evidence

| Command or check | Exit code | Evidence |
| --- | ---: | --- |
| `node --test src/features/outreach/links/links-source.test.mjs` | `0` | 4/4 passed: Candidate KPI separation; re-frozen routes/header/body; Recovered, observation, immutable evidence, events, stale and job state; seek pagination and read/command failure states. |
| `npm run typecheck` | `0` | `tsc --noEmit` passed. |
| `npm run lint` | `0` | `eslint .` passed. |
| `npm run build` | `0` | `tsc -b && vite build` passed; Vite emitted only its non-fatal existing chunk-size advisory. |
| `git diff --check -- frontend/src/features/outreach/links backend/core/docs/execution/parallel-blocks/PB-FE-LINKS-result.md` | `0` | No reported whitespace errors. |

Local Vite fixture verification used
`http://127.0.0.1:5178/src/features/outreach/links/manual-preview.html`.

| Browser scenario | Evidence |
| --- | --- |
| Desktop `1440x1000` | Candidate showed `0` successful records and the separate status tabs. Confirmed detail rendered first validation, latest Observation `stale`, immutable evidence read, `placement.recovered` timeline event, server `job-running`, and accepted reverify result. `innerWidth` and document `scrollWidth` were both `1440`. |
| Mobile `390x844` | Recovered Placement detail was visually inspected. `innerWidth` and document `scrollWidth` were both `390`; no document-level horizontal overflow. All detail URL anchors fit within their containers. |
| Keyboard | `Tab`, `Enter` selected Confirmed, then selected Recovered. `Enter` operated the tabs; `Escape` closed the detail sheet and returned focus to the detail trigger. |
| Failure fixtures | List `403` rendered forbidden without fallback data; list `409` rendered conflict without success inference; empty rendered its explicit empty state. The directed test covers the corresponding loading, generic-error, detail/event/evidence, and reverify paths. |

## External Effects

- The temporary Vite server on `127.0.0.1:5178` was used only for the local
  fixture and is stopped before handoff.
- No provider, DataForSEO, Browser worker, database, queue, object storage,
  production API, commit, push, merge, rebase, or reset operation occurred.
