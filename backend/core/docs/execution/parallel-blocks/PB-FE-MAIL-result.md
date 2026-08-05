# PB-FE-MAIL Result

Task: `BL-AI-140`
Status: `HANDOFF_READY`
Date: `2026-07-29`
Handoff updated at: `2026-07-29T10:35:14+08:00`

## Preconditions

- BL-AI-130 through BL-AI-139 behavior and the current PB-D Result were
  reviewed before the frontend synchronization.
- BL-AI-139 now provides frozen module-private list, detail, thread, paging,
  and sanitized-content DTOs. Its focused tests and full Core verification
  exit `0`.
- The user explicitly requested synchronization of BL-AI-130 through
  BL-AI-139 to the frontend.
- This round executed BL-AI-140 only. BL-AI-141 was not started.
- Work stayed inside `frontend/src/features/outreach/mail/**` and this Result
  file. Protected application shell, shared client, global route, shared
  OpenAPI, and Canonical State paths were not edited.

## Exact Changed Files

- `frontend/src/features/outreach/mail/types.ts`
- `frontend/src/features/outreach/mail/api.ts`
- `frontend/src/features/outreach/mail/project-key.ts`
- `frontend/src/features/outreach/mail/mail-center.tsx`
- `frontend/src/features/outreach/mail/mail-center-source.test.mjs`
- `frontend/src/features/outreach/mail/mail-sync-status-panel.tsx`
- `backend/core/docs/execution/parallel-blocks/PB-FE-MAIL-result.md`

## Implemented Boundary

- Added an Email Center inside the existing mail feature panel with
  `all`, `unmatched`, `candidates`, and `confirmed` filters.
- Added project-scoped reply list loading, cursor pagination, thread detail,
  match-state rendering, and explicit empty/loading/error states.
- Plain text is preferred. Sanitized HTML is rendered only when both DTO safety
  flags are present, inside a sandboxed iframe with `referrerPolicy=no-referrer`.
  No `dangerouslySetInnerHTML` path was added.
- Candidate rows show confidence and evidence. Manual confirmation requires an
  explicit candidate selection plus a confirmation reason.
- Confirmation sends the target Opportunity, thread version, message version,
  and `expectedMatchStatus=CANDIDATES_READY`.
- Only the exact success DTO is accepted as success. Unknown, stale, `403`,
  `409`, and request-failure responses remain non-success states.
- Controls are keyboard-operable and the layout remains usable at desktop and
  390-pixel mobile widths.

## Failure-First and Static Verification

| Command | Exit code | Result |
| --- | ---: | --- |
| `node --test src/features/outreach/mail/mail-center-source.test.mjs` before implementation | `1` | Expected RED result: 3 tests failed because the frontend mail modules did not exist. |
| Initial `npm run build` | `1` | Exposed an invalid fallback status union in `mail-center.tsx`; the minimal type-safe fallback was implemented. |
| Initial `npx prettier --check src/features/outreach/mail` | `1` | Identified five formatting differences; only the allowed mail feature files were formatted. |
| `node --test src/features/outreach/mail/mail-center-source.test.mjs src/features/outreach/gmail/gmail-source.test.mjs` | `0` | Mail and existing Gmail source contracts passed, `8/8`. |
| `npm run typecheck` | `0` | Frontend TypeScript gate passed. |
| `npm run lint` | `0` | Frontend lint gate passed. |
| `npm run build` | `0` | Vite 8.1.5 built 2,298 modules in 1.10 seconds. |
| `npx prettier --check src/features/outreach/mail` | `0` | Final formatting gate passed. |

The build retained the repository's existing warning that the minified
JavaScript chunk is larger than 500 kB (`1,045.30 kB`, gzip `326.90 kB`).
It did not fail the build.

## Browser Verification

Playwright used local HTTP route fixtures against the existing Vite server at
`http://127.0.0.1:5173`; it did not call live Core or provider services.

| Scenario | Exit code | Result |
| --- | ---: | --- |
| Desktop, `1440x1000` | `0` | Verified list, thread, sanitized HTML, no document horizontal overflow, cursor pagination, Space-key candidate selection, Enter-key confirmation, exact DTO success handling, and `409` conflict handling. |
| Mobile and error states, `390x844` | `0` | Verified no document horizontal overflow, empty state, `403`, request failure, and stable responsive layout. |
| Sanitized HTML isolation | `0` | The iframe sandbox exposed no permissions, and an injected script could not set a parent-window marker. |

The sandboxed iframe script-block console message and mocked `409` network
message were expected gate evidence. No unexplained final browser warning was
observed.

## Unproved Items and Shared Integration Request

- The Email Center is mounted in the allowed
  `mail-sync-status-panel.tsx`. The older mock mail presentation still
  coexists because the protected `outreach-workspace.tsx` shell was not
  editable in this task.
- BL-AI-135 confirmation and BL-AI-139 mail routes are not yet registered in
  the global Core server or shared OpenAPI contract. Browser verification used
  local route fixtures, so live frontend-to-Core availability remains
  unproved.
- A later shared integration task must register those module-private routes,
  publish the DTOs through the shared contract/gateway, and decide whether the
  Email Center replaces the older mock presentation.
- No claim is made about live Gmail, DataForSEO, AI, production object storage,
  production database, or production frontend behavior.

## External Effects

- No real Gmail, DataForSEO, AI, object-storage, or production-database call
  was made. DataForSEO remains present and unchanged.
- The existing Vite process was reused and was not started or stopped by this
  task. Playwright intercepted only local browser requests.
- No commit, push, merge, rebase, or reset was performed.
- PB-FE did not write Canonical State. During this run, another workspace
  change changed its SHA-256 from
  `464037B94E7717194C3D7DE2B89D54B4EB2C0C2DAC36A0824C7BBAFD5A4F9B20`
  to
  `A2F6F62CAFF8D523C9AE2992D2A2E4FABF7B4837DF34A06479FCB8E2790DA18E`.
  The file still contains no BL-AI-137 through BL-AI-140 row, and this task did
  not revert the concurrent change.
