# PB-LOCAL-PRODUCT-FINAL Execution Patch

Status: ACTIVE
Execution mode: STRICT_SERIAL
Started: 2026-08-03
Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo`

## Objective

Run the GrowthOS Backlinks module as a complete local product. This block does
not authorize public deployment, a public domain, Cloudflare Tunnel, production
infrastructure, customer data, Google Search Console, Indexing API, or Sitemap
API.

The authoritative product flow is:

`Opportunity -> confirmed Contact -> AI Draft -> user edit -> user approval -> final send confirmation -> Gmail send -> reply sync -> Email Center`

## Serial Order

Execute exactly:

`LP-FINAL-001 -> LP-FINAL-002 -> LP-FINAL-003 -> LP-FINAL-004 -> LP-FINAL-005 -> LP-FINAL-006 -> LP-FINAL-GATE`

A phase starts only after its predecessor is recorded as `PASS`. Missing real
AI credentials or an unavoidable browser action may produce
`CODE_COMPLETE_INPUT_REQUIRED`; code or infrastructure defects produce
`BLOCKED`.

## Product Boundaries

- Browser traffic reaches Backlinks only through FastAPI on
  `http://localhost:7200`.
- Private Fastify Core remains loopback-only on `127.0.0.1:7301`.
- Frontend runs on `http://localhost:5173`.
- PostgreSQL 18 and Temporal use persistent local storage.
- `DATAFORSEO_ENABLED=false`; email generation, approval, send, and sync do not
  depend on DataForSEO.
- GSC, Search Console, Indexing API, and Sitemap API calls remain zero.
- AI may create an editable Draft only. It cannot approve, send, or mutate
  Opportunity business state.
- Every send requires server-validated approval and a separate final user
  confirmation.
- A recipient must be an active, non-guessed, confirmed Contact belonging to
  the current Opportunity's Prospect.
- The Worker reads the recipient and content only from an immutable
  `SendSnapshot`.
- Gmail, AI, DataForSEO, and Browser capabilities remain independently gated,
  fail closed, and controlled by Provider Kill Switches.
- Secrets, tokens, API keys, OAuth codes, PKCE verifiers, and raw credentials
  stay outside the repository, logs, database business fields, and reports.
- Existing healthy Gmail OAuth tokens are retained and are not reauthorized
  without need.
- Existing working-tree changes are preserved. No commit, push, pull, merge,
  rebase, or reset is authorized.

## Migration Rule

The baseline deployment manifest heads are Alembic `20260724_0007` and
Backlinks `0034`. The next Backlinks schema change for this block must be the
forward-only migration `0035`; released migrations must not be inserted,
renumbered, or rewritten.

## Result States

- `PASS_LOCAL_PRODUCT`: all automated gates and one controlled real AI/Gmail
  closure passed.
- `CODE_COMPLETE_INPUT_REQUIRED`: implementation and automated verification
  passed, with only one explicit credential or human browser action remaining.
- `BLOCKED`: a code defect or infrastructure fault prevents completion.

Historical `PB-LIVE-ACTIVATION` evidence remains unchanged and is not reused as
proof that this new product-final block has passed.
