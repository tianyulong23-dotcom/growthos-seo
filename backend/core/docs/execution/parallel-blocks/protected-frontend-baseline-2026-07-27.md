# Protected Frontend Baseline

> Captured: 2026-07-27
> Purpose: preserve frontend work synchronized through `BL-AI-080` while backend and feature-private blocks run in parallel

## Protected Files

| SHA-256 | File |
|---|---|
| `bc3f06ce438ec74fd5e784e0dd9a6e1a972955736dde8ca1323fedf2f0d966f8` | `frontend/src/features/projects/project-workspace.tsx` |
| `fd9e5b69d07841b2987303b8e2218a7fe692604008f2f0950f1a02217be83e2d` | `frontend/src/features/outreach/outreach-workspace.tsx` |
| `f7493ca2a28dcd8bdc8ac92cc53aaf6a994bbe079859534c4232e7912eb3959c` | `frontend/src/features/outreach/api/client.ts` |
| `865f6aa56d79c9367fd12d91d6e64e7411ade1a3db8f9baca92f4b459e3a086e` | `frontend/src/App.tsx` |
| `790353b5cac6dd408a9211f105500ded7fe500e79a32b7c6eb96d23172762422` | `frontend/src/app/app-shell.tsx` |
| `1205c138b38ffc62d8d209d3b8105e2bc03bd8964d3dc57b7e0d1e12d2085afd` | `frontend/src/index.css` |

## Protected Behavior

- Website Projects remains inside Backlinks.
- Existing top-level navigation is preserved.
- Root information density remains 16px.
- Recommendations and Opportunities remain visible.
- Opportunity list/detail preserves the four independent axes.
- Pause/archive/restore management controls remain available.
- Existing stable pagination and project isolation behavior remain.

## Change Rule

- Backend and feature-private blocks must leave all listed hashes unchanged.
- Only the integration controller may intentionally change these files.
- An intentional change must name the owning original task, list the exact file, explain why module-private composition is insufficient, and run existing plus new frontend tests.
- `BL-AI-180` through `BL-AI-197` may change listed files only within the active task's explicit allowlist.
- Final acceptance must recompute every hash and classify each difference as `UNCHANGED` or `INTENTIONAL_AND_VERIFIED`.

## BL-AI-082 Through BL-AI-090 Explicit Synchronization

Date: 2026-07-27
Authority: explicit user request

| Classification | Current SHA-256 | File | Owning scope |
|---|---|---|---|
| `UNCHANGED` | `bc3f06ce438ec74fd5e784e0dd9a6e1a972955736dde8ca1323fedf2f0d966f8` | `frontend/src/features/projects/project-workspace.tsx` | Protected project information architecture |
| `INTENTIONAL_AND_VERIFIED` | `82168f7a17878b94fdfed56b4a5519f92e65ddc327f9f867879ef437f4938f4b` | `frontend/src/features/outreach/outreach-workspace.tsx` | BL-AI-082 through BL-AI-090 status and safety presentation |
| `INTENTIONAL_AND_VERIFIED` | `02eac46844c53e6590195c90cf6bb6d49b045d5acd0f03ebfb450e2e79971cba` | `frontend/src/features/outreach/api/client.ts` | BL-AI-084 public Assessment run/result contract |
| `INTENTIONAL_AND_VERIFIED` | `5ccda959136871b4b16c368075b74beea077aba0a1eb4ddb1718abd3034ad6a0` | `frontend/src/features/outreach/mock-data.ts` | BL-AI-082 through BL-AI-090 provider-neutral demonstration state |
| `UNCHANGED` | `865f6aa56d79c9367fd12d91d6e64e7411ade1a3db8f9baca92f4b459e3a086e` | `frontend/src/App.tsx` | Protected route composition |
| `UNCHANGED` | `790353b5cac6dd408a9211f105500ded7fe500e79a32b7c6eb96d23172762422` | `frontend/src/app/app-shell.tsx` | Protected navigation shell |
| `UNCHANGED` | `1205c138b38ffc62d8d209d3b8105e2bc03bd8964d3dc57b7e0d1e12d2085afd` | `frontend/src/index.css` | Protected 16px root density |

### Intentional Difference

- Assessment detail now shows the latest run status, attempts, errors, and
  whether a successful snapshot belongs to the latest run or is a preserved
  prior result.
- Draft detail exposes immutable evidence-snapshot/version, Prompt/output
  contract versions, Fake-or-disabled adapter mode, required human approval,
  and automatic-send-disabled state.
- Existing local draft actions are explicitly labelled demonstration behavior.
  They do not call a real AI provider, configure a Secret Ref, or implement the
  later BL-AI-097 backend-authoritative editor.
- Website Projects, top-level navigation, four Opportunity axes, management
  controls, stable pagination, and 16px root density remain unchanged.

### Verification

- Frontend Prettier: PASS.
- Frontend TypeScript typecheck: PASS.
- Frontend ESLint: PASS.
- Frontend production build: PASS.
- Port `4174`: HTTP 200.
- Playwright desktop and mobile rendering: PASS.

## BL-AI-121 Through BL-AI-130 Explicit Synchronization

Date: 2026-07-28
Authority: explicit user request

| Classification | Current SHA-256 | File | Owning scope |
|---|---|---|---|
| `INTENTIONAL_AND_VERIFIED` | `11668907222752181c9039b111c3d11225314a5cbbbe0cb5ddcce287690ca6b0` | `frontend/src/features/projects/project-workspace.tsx` | Pre-existing synchronized project presentation through BL-AI-120; unchanged by BL-AI-130 |
| `INTENTIONAL_AND_VERIFIED` | `3587a660c222e364b06b27565b594f5b9f083b76ca9d854b670378e7f53c39e2` | `frontend/src/features/outreach/outreach-workspace.tsx` | BL-AI-121 through BL-AI-130 Gmail composition; BL-AI-130 adds the read-only mail-sync status panel and removes the fake reply-check action |
| `INTENTIONAL_AND_VERIFIED` | `add2e3bb08030b9208f4188ed8deabb9fe82f3a6239507eafcd1cb30e9c75006` | `frontend/src/features/outreach/api/client.ts` | Pre-existing frozen public outreach contracts through BL-AI-122; unchanged by BL-AI-130 |
| `INTENTIONAL_AND_VERIFIED` | `184660d61e6818e6b776426f3d563c7b4a9fa8633789af328968819480bb8b46` | `frontend/src/features/outreach/mock-data.ts` | Pre-existing provider-neutral demonstration state through BL-AI-120; unchanged by BL-AI-130 |
| `UNCHANGED` | `865f6aa56d79c9367fd12d91d6e64e7411ade1a3db8f9baca92f4b459e3a086e` | `frontend/src/App.tsx` | Protected route composition |
| `UNCHANGED` | `790353b5cac6dd408a9211f105500ded7fe500e79a32b7c6eb96d23172762422` | `frontend/src/app/app-shell.tsx` | Protected navigation shell |
| `UNCHANGED` | `1205c138b38ffc62d8d209d3b8105e2bc03bd8964d3dc57b7e0d1e12d2085afd` | `frontend/src/index.css` | Protected 16px root density |

### BL-AI-130 Intentional Difference

- The shared Email Center composes one feature-private mail-sync panel because
  that workspace is the established Gmail review surface; no route, shell,
  global API client, project workspace, or global CSS change was needed.
- The panel uses the server-owned `mailSyncCapability` only and fails closed
  when status is unavailable. It has no sync action and does not report a
  successful run.
- BL-AI-124 through BL-AI-130 are shown as enforced capability and policy
  boundaries, including the fixed expired-cursor repair limits and audit event.
- Existing Website Projects, navigation, Opportunity axes, management
  controls, stable pagination, and 16px root density remain intact.

### Verification

- Changed-file Prettier: PASS.
- Frontend TypeScript typecheck: PASS.
- Frontend ESLint: PASS.
- Frontend production build: PASS with the existing chunk-size advisory.
- Port `4174`: HTTP 200.
- Playwright desktop `1440x1000` and mobile `390x844`: PASS with no page-level
  horizontal overflow.
