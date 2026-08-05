# PB-FE-DRAFT Result

Status: INTEGRATED
Baseline date: 2026-07-27
Task: BL-AI-097
Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo`

## Blocker Resolution

All three recorded shared-change requests were resolved before the editor was
integrated:

- `SCR-BL-AI-097-DRAFT-READ-001`: added a project-scoped, permission-checked
  current Draft read route through private Fastify, public FastAPI, Backlinks
  OpenAPI, and aggregate Platform OpenAPI.
- `SCR-BL-AI-097-DRAFT-FORMAT-002`: added a strict allowlisted
  ProseMirror/Tiptap JSON document contract. The server validates the
  structure, derives plain text, rejects raw HTML/unknown nodes/unknown marks,
  and synthesizes a safe document for historical plain-text versions.
- `SCR-BL-AI-097-FE-DEPS-003`: pinned `@tiptap/react`,
  `@tiptap/starter-kit`, and `@tiptap/extension-link` to exact version
  `3.28.0`, including transitive Tiptap overrides.

## Integrated Behavior

- The editor hydrates from the backend-authoritative current Draft snapshot.
- Save appends an immutable manual version using the backend
  `expectedVersion`; it never replaces an existing version.
- Approval uses the current backend version and changes the editor to
  read-only after the refreshed response reports `approved` or `sent`.
- Approved formatting is restricted to paragraphs, bullet/ordered lists,
  list items, text, hard breaks, bold, italic, and absolute HTTP(S) links.
- The frontend stores and sends structured JSON only. It does not call
  `getHTML`, use `dangerouslySetInnerHTML`, accept raw HTML, or expose a send
  command.
- Real AI remains disabled by default. Every AI output contract still requires
  user confirmation and fixes `canAutoSend` to `false`.

## Main Files

- `backend/core/src/modules/backlinks/domain/drafts/draft-document.ts`
- `backend/core/src/modules/backlinks/application/commands/draft.command.ts`
- `backend/core/src/modules/backlinks/application/queries/draft.query.ts`
- `backend/core/src/modules/backlinks/api/draft.route.ts`
- `backend/core/src/modules/backlinks/repositories/draft-generation.repository.ts`
- `backend/core/src/modules/backlinks/db/schema/drafts.ts`
- `backend/core/src/modules/backlinks/db/migrations/0022_backlink_draft_documents.sql`
- `backend/api/app/core/backlinks_gateway.py`
- `backend/api/app/api/routes/backlinks.py`
- `backend/contracts/openapi/backlinks.v1.json`
- `backend/contracts/openapi/platform.v1.json`
- `frontend/src/features/outreach/drafts/**`
- `frontend/src/features/outreach/registration.ts`
- `frontend/package.json`
- `frontend/package-lock.json`

## Verification

| Check                            | Result                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| BL-AI-097/098 focused Core suite | 11 files, 60 tests passed                                                            |
| Full Core gate                   | `npm run verify:backlinks` exited 0                                                  |
| Core Unit                        | 21 files, 138 tests passed                                                           |
| Core API                         | 19 files, 55 tests passed                                                            |
| Core Contract                    | 14 files, 75 tests passed                                                            |
| Core Integration                 | 34 files, 102 tests passed; 4 files/13 tests environment-gated skipped               |
| Core Security                    | 6 files, 95 tests passed                                                             |
| Core Resilience                  | 1 file, 3 tests passed                                                               |
| Dependency governance            | Source manifest 21, allowlist PASS, licenses 603, production audit 0 vulnerabilities |
| Backlinks OpenAPI                | 22 paths passed                                                                      |
| Aggregate Platform OpenAPI       | 44 public paths, 48 operations                                                       |
| FastAPI                          | 32 passed, 2 database-environment skipped                                            |
| Ruff                             | PASS                                                                                 |
| PostgreSQL 18.4                  | Manifest, clean install, historical upgrade, backup, and restore passed              |
| Frontend                         | Typecheck, ESLint, Prettier, production build passed                                 |
| Draft frontend contracts         | 3/3 passed                                                                           |
| Tiptap dependency tree           | All required packages resolve to `3.28.0`                                            |
| Protected frontend baseline      | All six current protected hashes matched                                             |

The production build emitted only the existing non-blocking large-chunk
warning.

## Browser Verification

- Desktop: loaded backend Draft version 1, saved a manual version 2, approved
  with `expectedVersion=2`, refreshed to approved version 3, and retained the
  edited subject after reload.
- Mobile `390x844`: approved version 3 rendered without page-level horizontal
  overflow or overlapping controls.
- The observed save payload contained only `expectedVersion`, `subjectText`,
  and `bodyDocument`; it contained no `bodyHtml`, derived `bodyText`, or send
  command.
- A clean browser session had no application/API console error. The only
  browser warning was the existing development favicon `404`.

Screenshots:

- `frontend/output/playwright/bl-ai-097-draft-desktop.png`
- `frontend/output/playwright/bl-ai-097-draft-mobile.png`

## External Effects

- No real AI, Gmail, Google, crawler, or other provider call.
- No supplied credential or Secret Reference use.
- PostgreSQL verification used disposable Docker resources only.
- No production or persistent database/resource mutation.
- No automatic send, Git commit, or push.

## Handoff

`BL-AI-097 = INTEGRATED`

The historical `BL-AI-097 = BLOCKED` state row is retained as failure-first
evidence. The integration result is recorded by a later state row.
