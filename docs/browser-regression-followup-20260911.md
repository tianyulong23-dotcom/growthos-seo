# Browser Regression Follow-up - 2026-09-11

## Scope

Follow-up to the four pre-existing browser failure categories recorded in
`agent-integration-20260911.md`. Starting HEAD:
`dc5baa3f2bc9ee85ac29b8d318890aa83c482845`.

Only shared button styling, browser regression coverage and its server are changed. Existing
local checkpoints remain excluded from Git. Publication target remains
`refs/heads/外链ver`; remote `main` is not a publication target.

## Findings and Fixes

1. Unavailable metrics now display "暂无数据". The regression checks all three
   missing values and rejects fabricated zero values.
2. Joined opportunities now display "已加入外链机会". Both pointer and keyboard
   tests use the current label. The pointer test also checks that refresh retains
   the disabled join action and that only one create request was sent, before
   testing archive, undo and V2 get-more contracts.
3. Manual contact entry is inside "手动添加其他邮箱"; role labels are localized.
   The test checks that generation stays disabled before confirmation, no contact
   write or draft job is sent during review, the entered reason reaches both
   candidate creation and version-checked confirmation, and confirmation allows
   draft generation. No contact or recommendation production logic was changed.
4. Shared `transition-all` animated opacity when an unavailable button became
   enabled. A delayed status response reproduced opacity 0.5 on the now-enabled
   button in all four desktop/mobile and light/dark combinations. Restricting
   the transition to colors makes enabled opacity immediately 1 while retaining
   the disabled state and its styling. Normal and hover contrast remain checked.

The complete run exposed two additional issues previously masked by earlier
assertion failures or timing:

- The opportunity detail's destructive action had 4:1 contrast in light mode
  and 4.49:1 in the new dark-mode check. Text now uses a darker mix of the existing
  destructive token in light mode and a lighter mix in dark mode. New tests scan
  normal and hovered detail actions in both themes and viewports.
- The Agent browser helper checked mobile visibility before rendering completed,
  occasionally choosing the desktop locator on mobile. It now waits for either
  real entry point to become visible before choosing. Streaming, manual
  scroll-away, onboarding and retry assertions are retained.
- The layout test combined five accessibility scans and several independent
  page workflows within one 30-second budget. Composition/send and reply/link
  layout checks now use separate fixtures, retaining every assertion.
- Full-suite traces showed repeated development-module loading exhausting the
  layout budget and leaving the placement page loading past its assertion.
  The browser server now builds and previews the production assets using Vite's
  API. Every run builds fresh assets; assertion and test timeouts are unchanged.

## Evidence Boundary

Browser tests intercept APIs and use deterministic fixtures. They exercise the
production UI, request construction and simulated workflow transitions, but are
not real-provider, real-Gmail, deployment or human-UAT acceptance. No real email,
provider job, database migration or credential change is authorized or performed.

Historical failures in the integration report remain an accurate record of that
earlier run; this follow-up records their subsequent resolution.

## Reproduction

From `frontend`, using installed dependencies and a free test-server port:

```powershell
$env:PLAYWRIGHT_PORT='4209'
$env:PLAYWRIGHT_CHANNEL='chrome'
node node_modules/@playwright/test/cli.js test
node node_modules/vitest/vitest.mjs run --maxWorkers=2
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit --incremental false
node node_modules/typescript/bin/tsc -p tsconfig.backlinks-v2-contract.json --noEmit --incremental false
node node_modules/vite/bin/vite.js build
node scripts/generate-backlinks-client.mjs --check
```

The complete browser command has no exclusions and no retries configured.
Browser output is stored locally under `frontend/output/playwright/` and is not
published as source.

## Final Verification

Verified on 2026-09-11 against the final code:

- Complete Playwright suite: 60 passed, 0 failed, 0 skipped, no retries (3.4m).
  Both desktop and mobile projects include Agent onboarding/profile/retry,
  successive streaming and manual scroll-away, and adjacent outreach workflows.
- Frontend Vitest: 98 files and 642 tests passed (116.77s).
- Application and Backlinks V2 contract TypeScript checks passed.
- ESLint passed for all changed frontend source, test and server files.
- Fresh production build passed as part of browser-server startup.
- Generated Backlinks client check passed: 89 operations.
- Desktop and mobile button screenshots were inspected alongside the automated
  normal/hover, light/dark contrast checks.

Build warnings about the existing keyword-query-client dynamic/static import
and chunks larger than 500 kB remain; these are not build failures. This
follow-up does not claim backend, real-provider or deployment acceptance.
