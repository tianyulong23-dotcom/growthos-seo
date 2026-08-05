# PB-FE-REPORTS Result

Status: INTEGRATED
Integrated tasks: `BL-AI-177`, `BL-AI-178`
Integrated at: 2026-07-30
Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo`
Next task: `BL-AI-179` NOT STARTED

## Scope

The feature-private Reports and Settings implementations were preserved and
accepted against the frozen Metrics, Reports, Export, Settings, Kill Switch,
and Retention OpenAPI/DTOs.

After the feature handoff returned `HANDOFF_READY`, the main-directory
integration controller completed the shared ownership work:

- registered Reports and Settings in the existing Backlinks navigation;
- mounted both workspaces under the protected
  `/projects/:projectId/backlinks/:view` workspace;
- passed the route-derived Website Project key and the existing shared API
  clients;
- read the Reports timezone and lookback window from server Settings rather
  than browser-local timezone;
- suppressed the unrelated generic header action on Reports and Settings;
- added shared-route source acceptance tests; and
- updated this result and Canonical State.

Integration-controller changes are limited to:

- `frontend/src/features/outreach/manifest.ts`
- `frontend/src/features/outreach/module.tsx`
- `frontend/src/features/outreach/outreach-workspace.tsx`
- `frontend/src/features/outreach/reports/reports-workspace.tsx`
- `frontend/src/features/outreach/reports/reports-source.test.mjs`
- `frontend/src/features/outreach/settings/settings-source.test.mjs`
- `backend/core/docs/execution/parallel-blocks/PB-FE-REPORTS-result.md`
- `backend/core/docs/execution/backlinks-ai-coding-state.md`

No second Browser Worker, Queue, Launcher, or network stack was created.
Browser remains default-off, DataForSEO is unchanged, and `BL-AI-179` was not
started.

## Reports Contract

The Reports feature consumes only these frozen public operations:

- `GET /api/v1/projects/{websiteProjectKey}/backlinks/metrics/dashboard`
- `GET /api/v1/projects/{websiteProjectKey}/backlinks/reports`
- `POST /api/v1/projects/{websiteProjectKey}/backlinks/reports/{reportKey}/revisions/{reportRevisionId}/exports`
- `GET /api/v1/projects/{websiteProjectKey}/backlinks/report-exports/{exportId}`
- `GET /api/v1/projects/{websiteProjectKey}/backlinks/report-exports/{exportId}/download`

The UI displays server-provided Metric Snapshots, trend points, reporting
window, Workspace timezone, Report Revision inputs/checksum/freshness, and
Export lifecycle state. Candidate remains excluded from successful Placement
KPI. The frontend does not calculate formal metrics, infer freshness, create
files, or fabricate download URLs. Download is enabled only for a completed
Export with a server object, and PDF remains disabled by
`PDF_EXPORT_DISABLED`.

## Settings Contract

The feature client consumes only these frozen public operations:

- `GET /api/v1/projects/{websiteProjectKey}/backlinks/settings`
- `PUT /api/v1/projects/{websiteProjectKey}/backlinks/settings`
- `PUT /api/v1/projects/{websiteProjectKey}/backlinks/settings/kill-switches/{capability}`

Verified DTO behavior:

- Settings writes send the server Settings `version` as `expectedVersion`.
- Kill Switch writes send the effective source `sourceVersion` as
  `expectedVersion`.
- 403 is represented for both read and command authorization failures.
- 409 is represented as an `ExpectedVersion` conflict requiring refresh.
- Dangerous Kill Switch changes require a non-empty reason and the exact
  `CONFIRM DANGEROUS CHANGE` confirmation.
- Only server-authorized `project` and `provider` layers can be selected.
- Provider-layer commands use only the Provider identity returned by the
  server DTO. No Provider name is invented by the frontend.
- Effective `global`, `organization`, and `workspace` sources remain visible
  as read-only facts and expose no mutation controls.

## DFS-COST Boundary

The acceptance was checked against the integrated `DFS-COST-001..006`,
`DFS-COST-GATE: PASS_DEVELOPMENT_ONLY`, and migration head `0032`.

- DataForSEO remains visible as a configured Provider.
- No ordinary `FORCE_LIVE` control or command is exposed.
- No Provider call, cost-control command, budget override, or Artifact API is
  fabricated by the Settings feature.
- Refresh calls only the frozen Settings governance GET operation; it does not
  invoke a Provider or a mutation command.
- No cross-tenant Artifact surface is present.
- No global or organization mutation setting is present.
- Existing running Jobs are described as retaining their startup-bound
  Settings version.

## Retention

Retention is read-only in this feature:

- Rules display server-provided category and retention days.
- `legal_hold`, `audit_record`, `lifecycle_record`, and
  `active_suppression` each have an explicit exception explanation.
- The page states that the read path only selects expired records and does not
  execute deletion.
- No Retention update or delete command exists in the feature.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Directed frontend tests | PASS | Reports, Settings, Links, Mail, and Gmail source suites: 26 tests, 26 passed |
| Typecheck | PASS | `npm run typecheck`: exit 0 |
| Lint | PASS | `npm run lint`: exit 0 |
| Production build | PASS | `npm run build`: exit 0; Vite 8.1.5 built 2302 modules |
| Formatting | PASS | Prettier check passed for all shared and feature files changed by the integration controller |
| Core regression | PASS | `npm run verify:backlinks`: Unit 397, API 86, Contract 144, Integration 171 passed with 13 skipped, Security 102, Resilience 8 |
| FastAPI regression | PASS | Locked Docker environment: Ruff passed; Pytest 34 passed, 1 skipped |
| Feature browser acceptance | PASS | Reports and Settings feature-private desktop/mobile artifacts retained; Settings console reported 0 errors and 0 warnings |

The build retains the existing non-fatal advisory that the main minified chunk
is larger than 500 kB.

## Feature-Private Browser Acceptance

Playwright acceptance was completed in the feature block before shared
integration. Reports artifacts cover desktop summary/completed Export and
390px summary/trends views. Settings acceptance covered:

- Desktop 1440x900 rendered Settings versions, DataForSEO, effective source
  layer/version, authorized controls, and Retention without overlap.
- A Settings save advanced server preview version 12 to version 13.
- GET 403 rendered `无权查看治理设置`.
- Settings command 403 and Kill Switch command 403 rendered
  `当前账号无权修改该设置`.
- Settings command 409 and Kill Switch command 409 rendered
  `ExpectedVersion 冲突，请刷新后重新提交`.
- Selecting the organization-sourced DataForSEO switch rendered a read-only
  notice and no mutation editor.
- Keyboard Tab reached Refresh, Settings inputs, switch rows, layer selector,
  reason, confirmation, and the dangerous command.
- Enter selected the DataForSEO Provider row. The dangerous command remained
  disabled until both reason and exact confirmation were entered, then Enter
  submitted it and advanced source version 5 to 6.
- At 390x844, document and body `scrollWidth` remained 390px. The Retention
  table used only its local horizontal overflow container.
- Console inspection reported 0 errors and 0 warnings.

Artifacts:

- `frontend/output/playwright/bl-ai-177/desktop-summary.png`
- `frontend/output/playwright/bl-ai-177/desktop-completed-export.png`
- `frontend/output/playwright/bl-ai-177/mobile-summary-390.png`
- `frontend/output/playwright/bl-ai-177/mobile-trends-390.png`
- `frontend/output/playwright/bl-ai-178/desktop-settings.png`
- `frontend/output/playwright/bl-ai-178/desktop-readonly-source.png`
- `frontend/output/playwright/bl-ai-178/desktop-settings-conflict.png`
- `frontend/output/playwright/bl-ai-178/mobile-settings-390.png`
- `frontend/output/playwright/bl-ai-178/vite.stdout.log`
- `frontend/output/playwright/bl-ai-178/vite.stderr.log`

## Handoff Boundary

Before the handoff, five protected files matched the feature-block turn-start
SHA-256 baseline:

- `frontend/src/App.tsx`: `865f6aa56d79c9367fd12d91d6e64e7411ade1a3db8f9baca92f4b459e3a086e`
- `frontend/src/app/app-shell.tsx`: `790353b5cac6dd408a9211f105500ded7fe500e79a32b7c6eb96d23172762422`
- `frontend/src/api/client.ts`: `8bbc36fcf1cbf65ec213cfb200d437506ad2629aecca99016f9f17ad080b3c6a`
- `frontend/src/index.css`: `1205c138b38ffc62d8d209d3b8105e2bc03bd8964d3dc57b7e0d1e12d2085afd`
- `frontend/src/features/outreach/api/client.ts`: `add2e3bb08030b9208f4188ed8deabb9fe82f3a6239507eafcd1cb30e9c75006`

Two pre-existing dirty protected workspace files changed concurrently while
BL-AI-178 acceptance was running. The feature block did not edit or revert
either file:

- `frontend/src/features/outreach/outreach-workspace.tsx`: turn-start `7bf9b9d99c14ebead82bb0e8092fcaa4bf3da349a1f8cb07da5c71ed7cd00dde`; final observed `0232857efa26e84c44b998ecd79d3d4b5632c2ff3abed518580fe333fee6bf71`
- `frontend/src/features/projects/project-workspace.tsx`: turn-start `11668907222752181c9039b111c3d11225314a5cbbbe0cb5ddcce287690ca6b0`; final observed `6273fd6b24608fa687cec2af3f7aecabe6d5a5a58f3825ec53162e5628d14a64`

After `HANDOFF_READY`, the main-directory integration controller intentionally
edited the shared Backlinks navigation and protected Outreach workspace. It
did not edit `frontend/src/api/client.ts`, backend implementation, OpenAPI,
migrations, DataForSEO implementation, global CSS, or Project workspace.
No real Browser, Provider, or DataForSEO call, production mutation, commit, or
push occurred.

INTEGRATED
