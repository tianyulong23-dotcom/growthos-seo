# PB-FE-GMAIL Synchronization Result

**Date:** 2026-07-28
**Status:** BL-AI-121 through BL-AI-130 frontend synchronization complete;
BL-AI-123 gate completed by `PB-G-PHASE-GATES`
**Covered tasks:** BL-AI-101 through BL-AI-120 safety projection; BL-AI-121
Gmail connection UI; BL-AI-122 approved-send confirmation; BL-AI-124 through
BL-AI-130 read-only mail-sync capability and policy projection
**Phase Gate:** `BL-AI-123 = DONE` (`PASS_DEVELOPMENT_ONLY`)

## Scope

- The existing Gmail connection status, connect/disconnect controls, and
  read-only send review remain connected only to their established public DTOs.
  No token, authorization code, credential, or local authoritative connection
  state is exposed.
- BL-AI-121 uses the frozen `backlinksGetGmailConnectionStatusV1`,
  `backlinksConnectGmailV1`, and `backlinksDisconnectGmailV1` contracts.
  `REAUTH_REQUIRED` and `TOKEN_REVOKED` explicitly require reconnection;
  `CONNECTED` with `PAUSED` availability is explicitly shown as
  `发送受限`; unavailable status remains `状态未知`, never connected.
- BL-AI-122 uses the frozen `backlinksCreateSendIntentV1` contract only from
  the approved Draft page. It requires the exact approved Draft Version, a
  connected and available Gmail Connection, an explicit second confirmation,
  and one read-only Contact Candidate. Missing, unreadable, or ambiguous
  candidates keep creation disabled rather than inventing a recipient choice.
  The request carries an `idempotency-key`, uses `INITIAL_OUTREACH` with
  `followUpIndex: 0`, and exposes only the server's `READY` result.
- A `READY` Send Intent is displayed as a recorded intent, not as delivery or
  send success. Network/server outcomes whose creation state is unknown remain
  explicitly unknown and retain the original idempotency key for safe retry.
- The Email Center now presents the 101-120 delivery safety boundary: HMAC-only
  suppression lookup, rolling quota reservation, progressive verification,
  server-side Kill Switch, contact frequency controls, reconciliation-required
  `DELIVERY_UNKNOWN`, and delivery feedback suppression.
- The feedback projection states the server-enforced behavior without inventing
  live data: `HARD_BOUNCE`, `COMPLAINT`, and `UNSUBSCRIBE` suppress
  immediately; a `SOFT_BOUNCE` suppresses only after three events in 30 days;
  an ordinary user cannot release an unsubscribe suppression.
- The pre-existing Email Center review sheet remains explicitly read-only and
  no longer exposes a fake reply-check action. The authoritative approved-send
  entry is the Draft page; no feedback/suppression or sync-run endpoint is
  invented.
- The Email Center now projects BL-AI-124 through BL-AI-130 through the frozen
  `mailSyncCapability` field only. It distinguishes unknown, disconnected,
  send-only, unavailable, and read-capable states without exposing tokens or
  claiming that a synchronization run occurred.
- The read-only mail-sync panel records the fixed safety boundary: optional
  `gmail.readonly`, project-isolated cursor and opaque MIME references,
  default-off Provider Adapter, seven-day initial sync, final-page History
  cursor commit, and seven-day / ten-page / 1,000-message expired-cursor repair
  with an audit event.

## Files

- `frontend/src/features/outreach/gmail/gmail-safety-panel.tsx`
- `frontend/src/features/outreach/gmail/api.ts`
- `frontend/src/features/outreach/gmail/types.ts`
- `frontend/src/features/outreach/gmail/use-gmail-connection.ts`
- `frontend/src/features/outreach/gmail/send-review-sheet.tsx`
- `frontend/src/features/outreach/gmail/gmail-source.test.mjs`
- `frontend/src/features/outreach/mail/mail-sync-status-panel.tsx`
- `frontend/src/features/outreach/outreach-workspace.tsx`
- `frontend/src/features/outreach/drafts/api.ts`
- `frontend/src/features/outreach/drafts/types.ts`
- `frontend/src/features/outreach/drafts/draft-page.tsx`
- `frontend/output/playwright/bl-ai-120-send-review-desktop.png`
- `frontend/output/playwright/bl-ai-120-send-review-mobile.png`
- `frontend/output/playwright/bl-ai-121-gmail-connection-desktop.png`
- `frontend/output/playwright/bl-ai-121-gmail-connection-mobile.png`
- `frontend/output/playwright/bl-ai-122-send-confirmation-desktop.png`
- `frontend/output/playwright/bl-ai-122-send-confirmation-mobile.png`
- `frontend/output/playwright/bl-ai-130-mail-sync-desktop.png`
- `frontend/output/playwright/bl-ai-130-mail-sync-mobile.png`

## Verification

| Check | Result |
| --- | --- |
| Gmail mail-sync source contracts | PASS, 5/5 |
| Changed-file Prettier | PASS |
| Frontend typecheck | PASS |
| Frontend ESLint | PASS |
| Frontend production build | PASS; existing chunk-size advisory only |
| Desktop browser review | PASS at `1440x1000`; mail-sync capability and BL-AI-124..130 policy projection are readable with no page-level horizontal overflow |
| Mobile browser review | PASS at `390x844`; the new panel and send review remain reachable with no page-level horizontal overflow |
| Runtime truthfulness | PASS; unavailable public status remains `状态未知`, and no sync action or `同步成功` claim is exposed |

## Integration Boundary

The user explicitly authorized frontend synchronization through BL-AI-130.
The shared Email Center consumes only frozen public Gmail connection fields and
does not invent a mail-sync command or runtime status API. BL-AI-124..130 are
therefore represented as capability and enforced-policy facts, not as a claim
that Gmail data was synchronized. The earlier BL-AI-122 browser verification
used a deterministic local API stub and did not submit a Send Intent; the
separate BL-AI-123 phase-gate proof observed only a `READY` intent. No check
claims a Gmail provider call, live suppression or delivery feedback, real
Google OAuth, credential use, plaintext token handling, production database
mutation, Gmail delivery, Git commit, or Git push.
