# PB-B-DRAFT-BE Result

Status: INTEGRATED
Baseline date: 2026-07-27
Tasks: BL-AI-086 through BL-AI-096

## Scope

- Implemented Draft persistence, domain rules, AI boundary contracts, Fake and
  disabled-by-default Real Adapter shells, structured-output repair, evidence
  policy, deterministic Prompt construction, generation workflow, status
  polling, manual editing, and approval.
- Integrated four Draft operations through the private Fastify service, public
  FastAPI Gateway, and generated Backlinks and aggregate OpenAPI contracts.
- Added forward-only migration `0013_backlink_drafts.sql` and integrated it
  into the shared deployment manifest.
- Kept `0012_backlink_gmail_connections.sql` reserved for the separate
  `PB-C1-GMAIL-AUTH` track. It was not integrated or executed by this block.
- Did not implement the BL-AI-097 frontend editor or BL-AI-098 Phase 05 Gate.

## Sequential Task Result

| Task | Result |
|---|---|
| BL-AI-086 | Added tenant-scoped Draft, immutable Version, immutable Evidence Snapshot, and Model Run tables with forced RLS and composite project constraints. |
| BL-AI-087 | Added the `generating/draft/approved/rejected/sent` state machine, immutable domain objects, and stable invalid-state errors. |
| BL-AI-088 | Added strict provider-neutral AI input/output schemas and classified timeout, rate-limit, malformed, refusal, unavailable, configuration, policy, and budget failures. |
| BL-AI-089 | Added deterministic Fake Adapter scenarios for success, refusal, timeout, malformed output, and privilege-escalation content. |
| BL-AI-090 | Added a disabled-by-default Real Adapter shell requiring Secret Ref, model, provider, timeout, and an injected transport; logs exclude prompt text and secrets. |
| BL-AI-091 | Added strict structured-output parsing with at most one repair attempt; policy failures are not repaired. |
| BL-AI-092 | Added the untrusted-evidence boundary, project/status/visibility/confidence checks, forbidden-output checks, and mandatory human approval. |
| BL-AI-093 | Added deterministic versioned Prompt construction using approved fields only. |
| BL-AI-094 | Added idempotent PostgreSQL generation workflow/repository behavior, atomic immutable versions, failure classification, and last-successful-version preservation. Concurrent manual edits prevent stale AI completion from becoming current. |
| BL-AI-095 | Added permission- and budget-gated create/status APIs with server-owned prompt/schema versions, idempotency, `202` creation, and polling. |
| BL-AI-096 | Added immutable manual-version and optimistic approval APIs. Approval requires `expectedVersion`; original versions remain unchanged. |

## Public Contract

The integrated Gateway exposes:

- `POST /api/v1/projects/{websiteProjectKey}/backlinks/opportunities/{opportunityId}/draft-jobs`
- `GET /api/v1/projects/{websiteProjectKey}/backlinks/draft-jobs/{jobId}`
- `POST /api/v1/projects/{websiteProjectKey}/backlinks/drafts/{draftId}/versions`
- `POST /api/v1/projects/{websiteProjectKey}/backlinks/drafts/{draftId}/approve`

The operation IDs are `backlinksCreateDraftJobV1`,
`backlinksGetDraftJobV1`, `backlinksSaveDraftVersionV1`, and
`backlinksApproveDraftV1`.

## Safety Contract

- Real AI execution remains disabled unless an explicit enabled configuration
  and injected transport are supplied.
- Web content remains untrusted evidence and cannot become a system
  instruction.
- Prompt construction excludes unapproved raw fields and cross-project data.
- Generated content cannot be sent automatically.
- Only a user-approved immutable version can enter the approved state.
- Provider failures and repair exhaustion do not overwrite the last successful
  Draft version.
- Logs contain provider/model references and failure codes, not prompts,
  generated bodies, or secrets.

## Verification

| Check | Result |
|---|---|
| PB-B focused suite | PASS, 10 files and 45 tests |
| Core typecheck and ESLint | PASS |
| Source/dependency/license gates | PASS, 21 source records and 603 packages |
| Full Core Unit | PASS, 19 files and 128 tests |
| Full Core API | PASS, 19 files and 55 tests |
| Full Core Contract | PASS, 14 files and 75 tests |
| Full Core Integration | PASS, 92 tests; 13 environment-gated skipped |
| Full Core Security | PASS, 6 files and 95 tests |
| Full Core Resilience | PASS, 3 tests |
| Backlinks OpenAPI | PASS, 17 paths |
| Aggregate Platform OpenAPI | PASS, 39 public paths and 43 operations |
| Full FastAPI | PASS, 30 tests; 2 database-environment skipped |
| Python Ruff | PASS |
| Deployment manifest | PASS, 4 tests |
| PostgreSQL 18.4 clean install | PASS |
| PostgreSQL 18.4 existing upgrade and historical read | PASS |
| PostgreSQL 18.4 backup and restore | PASS |
| Migration checksum | PASS, `03d9b4c3cac32fd5d7f1783d8c27adfa1a5aa8512298655985dc21256eb85f5a` |
| Docker residue | PASS, no labeled container or network remains |
| `git diff --check` | PASS |

The PostgreSQL verification used disposable pinned Docker resources. The
read-only Python containers emitted only expected cache-write warnings.

## BL-AI-088 Re-execution

Date: 2026-07-27
Result: PASS_NO_CHANGE

- Rechecked the V1.0 task card and V1.4 parallel-block boundary.
- The existing `AiDraftPort` remains provider-neutral and exposes strict Zod
  input and output schemas without a provider SDK or vendor response type.
- Timeout, rate-limit, malformed-output, refusal, unavailable, configuration,
  policy, and budget errors remain expressible through stable error codes.
- The focused BL-AI-088 Contract suite passed 6 of 6 tests.
- The full Core Contract suite passed 14 files and 75 tests.
- TypeScript typecheck, full ESLint, targeted ESLint, provider-coupling scan,
  and scoped `git diff --check` passed.
- No Port or test source change was required because the integrated
  implementation already satisfied the task acceptance criteria.
- BL-AI-091 through BL-AI-096 were not re-executed or modified.

## BL-AI-090 Re-execution and Frontend Synchronization

Date: 2026-07-27
Result: PASS_NO_SOURCE_CHANGE

- Rechecked the V1.0 task card and V1.4 shared-repository boundary.
- The disabled-by-default Real Adapter shell still requires explicit
  enablement, Secret Ref, Provider Ref, Model and a positive timeout, and it
  can execute only through an injected transport.
- The focused BL-AI-090 Contract suite passed 6 of 6 tests. The full Core
  Contract suite passed 14 files and 75 tests; TypeScript typecheck and ESLint
  passed.
- Prompt text, generated bodies and Secret Ref values remain absent from safe
  logs. No built-in fetch, Undici, Axios or provider SDK was added.
- No Adapter or Contract-test source change was required because the existing
  implementation already satisfied the acceptance criteria.
- The user explicitly authorized synchronization of BL-AI-082 through
  BL-AI-090. The frontend now exposes Draft evidence-snapshot/version,
  Prompt/output-contract, Fake/disabled adapter, mandatory-human-approval and
  automatic-send-disabled status without wiring the later Draft APIs.
- Existing local draft interactions are explicitly labelled as Fake/local
  demonstration behavior. No real provider transport, credential, model call,
  automatic send path or BL-AI-097 editor work was added.
- BL-AI-091 through BL-AI-096 were not re-executed or modified.

## BL-AI-089 Re-execution

Date: 2026-07-27
Result: PASS_NO_CHANGE

- Rechecked the V1.0 task card and V1.4 parallel-block boundary.
- The fixed scenarios cover success, refusal, timeout, malformed JSON, and
  privilege-escalation content.
- The Fake Adapter maps every scenario through the shared `AiDraftPort`,
  validates structured output, and rejects attempts to disable human
  confirmation or enable automatic sending.
- The focused BL-AI-089 Contract suite passed 5 of 5 tests.
- The full Core Contract suite passed 14 files and 75 tests.
- TypeScript typecheck, full ESLint, targeted ESLint, network/provider/
  credential scan, and scoped `git diff --check` passed.
- No Adapter, Contract test, or Fixture change was required because the
  integrated implementation already satisfied the task acceptance criteria.
- BL-AI-090 through BL-AI-096 were not re-executed or modified.

## BL-AI-091 through BL-AI-096 Re-execution

Date: 2026-07-27
Result: PASS_WITH_LAYERING_FIX

- Rechecked the V1.0 task cards and the V1.4 parallel-block boundary for all
  six tasks.
- BL-AI-091 focused structured-output tests passed 4 of 4. The first malformed
  output receives one repair attempt; a second malformed output and policy
  failures terminate without retry.
- BL-AI-092 focused Security tests passed 6 of 6. Web instructions remain
  untrusted evidence, forbidden values are not echoed, and output remains
  subject to human approval.
- BL-AI-093 focused Prompt Builder tests passed 3 of 3. Prompt construction is
  deterministic, versioned, and limited to approved evidence fields.
- BL-AI-094 focused PostgreSQL 17.10 workflow/repository tests passed 6 of 6.
  Replay does not duplicate generation, failures preserve the last successful
  version, and jobs remain traceable. The first run encountered a transient
  Docker Hub digest-resolution timeout; the pinned local image was verified
  and the supported retry passed without changing the test.
- BL-AI-095 focused create/status API tests passed 1 of 1. Permission, budget,
  idempotency, `202` creation, and project-scoped polling remain enforced.
- BL-AI-096 focused immutable editing/approval API tests passed 1 of 1.
  Editing creates a new version, approval requires `expectedVersion`, and the
  original version remains unchanged.
- Full `verify:backlinks` passed: Unit 134 of 134, API 55 of 55, Contract 75 of
  75, Integration 95 executed with 13 environment-gated skips, Security 95 of
  95, and Resilience 3 of 3. Typecheck, ESLint, source, dependency, license,
  OpenAPI, migration, and whitespace gates also passed.
- Full FastAPI passed 32 tests with 2 database-environment skips, and Ruff
  passed in the locked Python container. The generated aggregate OpenAPI was
  refreshed and revalidated at 44 public paths and 48 operations.
- The full lint gate exposed a domain-layer dependency violation in the Draft
  document validator. Zod validation was moved to an Application schema while
  the Domain module retained only owned types and pure conversions. No API,
  persistence, or frontend behavior changed.
- No real AI/provider call, credential use, production database operation,
  frontend synchronization, BL-AI-097 execution, Git commit, or push occurred.

## External Effects

- No real AI, Gmail, DataForSEO, crawler, or other provider call.
- No supplied credential use.
- No production or persistent database operation.
- Frontend synchronization was limited to the explicitly authorized
  BL-AI-082 through BL-AI-090 capability and safety status.
- No Git commit or push.

## Remaining Boundary

- `PB-FE-DRAFT -> BL-AI-097` has not started.
- `PB-G-PHASE-GATES -> BL-AI-098` has not started.
- Real provider credentials, real provider transport, production deployment,
  and product E2E remain unverified and unauthorized.
