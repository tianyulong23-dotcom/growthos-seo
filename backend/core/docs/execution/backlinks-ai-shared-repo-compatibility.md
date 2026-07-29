# Backlinks AI Shared Repository Compatibility

## Result

Date: `2026-07-24`

> Historical gate report: this report proved the local shared-repository gate.
> Later on `2026-07-24`, `BL-AI-074` completed and `BL-AI-075` became next.
> Integration with the separately declared `E:\seo-v4` repository is governed
> by a new `SEO-V4-REPO-GATE`; it is not proven by this report.

Reviewed scope: historical `BL-AI-001` through `BL-AI-073`, plus the
integration decisions and evidence produced by `BL-AI-ARCH-001` through
`BL-AI-ARCH-007`.

```text
SHARED-REPO-GATE = PASS
P0 unresolved = 0
P1 unresolved = 0
BL-AI-074 allowed = YES
```

This review does not rewrite the historical `DONE` results. It classifies the
existing implementation and records the completed shared-repository
integration follow-ups. `BL-AI-074` is unblocked by this gate but was not
executed.

## Assumptions And Evidence Boundary

- `PROVEN` means current repository content, command output, listener state, or
  a disposable PostgreSQL/Temporal execution proved the fact.
- Contract and Adapter tests are not described as deployed or production E2E.
- No real DataForSEO, Gmail, AI, production database, or supplied credential
  was used.
- The local frontend on port `4174` is a development runtime. The FastAPI
  Gateway and private Backlinks service were proved together only in
  disposable containers and are not claimed as persistent or deployed
  services.

## Gate Drift Fixed In This Task

`npm audit --omit=dev` initially failed with one High advisory against the
transitive `find-my-way@9.6.0` dependency. Fastify declares
`find-my-way@^9.6.0`, so the minimal gate fix updated only the transitive lock
resolution to `find-my-way@9.7.0`.

Affected governance artifacts were regenerated:

- `backend/core/package-lock.json`;
- `backend/core/src/modules/backlinks/third-party/THIRD_PARTY_NOTICES.md`;
- `backend/core/artifacts/sbom/backlinks-core-0.0.0.cdx.json`.

Direct dependencies and `package.json` were not changed. The final audit
reported zero vulnerabilities.

## Compatibility Classification

| Group | Historical scope | Classification | Evidence | Impact | Follow-up task | Tests |
|---|---|---|---|---|---|---|
| Foundation/Auth/Project | `BL-AI-001` through `BL-AI-024` | `ADAPT` | Backlinks module boundaries, errors, composition, and read contracts remain valid. `BL-AI-ARCH-004` added a signed `PlatformRequestContext.v1` producer/consumer contract and fail-closed Actor/Tenant/Project/Permission validation. `FU-003` now resolves authoritative Platform context, strips browser-forged internal headers, signs the internal envelope, and enforces route/project binding. | Domain code remains in `backend/core`; browser context headers are not trusted; the Gateway has no Backlinks SQL or state-transition implementation. | Completed adaptations: `BL-AI-ARCH-004` and `BL-AI-ARCH-008-FU-003`. | Unit `78/78`; API `46/46`; Contract `49/49`; Security `88/88`; Python pytest `11/11`. |
| Database/RLS/Audit/Outbox | `BL-AI-025` through `BL-AI-037`, plus Outbox/Phase-02 work in `BL-AI-040` and `BL-AI-041` | `ADAPT` | Published migrations `0001` through `0004` are retained. `BL-AI-ARCH-005` added forward-only migration `0005`, module schemas, roles, grants, and ownership tests without weakening forced RLS, audit, lifecycle, idempotency, or outbox behavior. | Backlinks remains the sole writer for its 21 tables; Gateway and other module roles cannot write them. | Completed adaptation: `BL-AI-ARCH-005`. Production role membership, backup, and restore evidence remain operations work, not local E2E proof. | Full PostgreSQL-enabled Integration `77/77`; migration check exit `0`; database ownership gate included; audit/lifecycle/outbox tests passed. |
| Provider/Cost/Temporal | `BL-AI-038` through `BL-AI-053` | `ADAPT` | Provider DTO isolation, budget reservation, cache, single-flight, Kill Switch, unknown-charge behavior, and default-off real Adapter remain valid. `BL-AI-ARCH-006` namespaced the Task Queue, Workflow/Activity types, Workflow IDs, event, and DataForSEO policy. | No paid call or retry policy was broadened. Temporal identifiers no longer use shared generic names. | Completed adaptations: `BL-AI-ARCH-006` and the required repository-local ownership approval in `FU-001`. Persistent deployment ownership remains an operations concern, not a claim made by this gate. | Contract namespace tests passed; disposable Temporal worker interruption/restart path passed; source manifest, allowlist, licenses, and audit passed. |
| Recommendation | `BL-AI-054` through `BL-AI-064` | `KEEP` | Domain normalization, gates, scoring, ranking, inventory, claim/release/reject, refill, query, and command behavior are Backlinks-owned facts with deterministic and tenant-scoped tests. | No shared platform rewrite is required. The Gateway forwards public commands once to the existing private handler and requires idempotency for reject/refill writes. | None for domain behavior. Public transport completed by `BL-AI-ARCH-008-FU-003`. | Unit/API/Integration suites passed, including PostgreSQL concurrency and RLS paths; the disposable runtime observed one reject command execution. |
| SafeFetch/Contact | `BL-AI-065` through `BL-AI-073` | `KEEP` | SSRF controls, DNS/private-address rejection, redirect revalidation, robots policy, bounded parsing, candidate evidence, discovery deduplication, and human confirmation remain module-private Backlinks behavior. | No public network or identity claim is added. Candidate syntax does not become a confirmed Contact without the existing command. The Gateway adds transport only. | None for domain behavior. Public transport completed by `BL-AI-ARCH-008-FU-003`. | Security `88/88`; API `46/46`; PostgreSQL-enabled Integration `77/77`; no real fetch or paid call. |
| API/OpenAPI | Cross-cutting `BL-AI-018` through `BL-AI-024`, `BL-AI-062`, `BL-AI-063`, and `BL-AI-073` | `ADAPT` | Backlinks independently generates eight operations. `FU-002` adds a loopback-default private Fastify bootstrap that reuses those eight registrars. `FU-003` adds exactly seven public FastAPI runtime adapters while the aggregate contract retains eight public paths including Platform health and excludes private Backlinks health. | The accepted `Frontend -> Gateway -> private Backlinks Core` path is runnable. Transport failures map to `BACKLINKS_UNAVAILABLE` without retry, SQL fallback, or invented success. | Completed: `BL-AI-ARCH-008-FU-002` and `BL-AI-ARCH-008-FU-003`. | Private bootstrap `3/3`; Python pytest `11/11`; shared contract checker reports 8 public paths, 0 cross-module events, and 1 module Task Queue; disposable runtime route count is 7. |
| Frontend shared hotspots | Authorized frontend synchronizations associated with completed work through `BL-AI-070`, normalized by `BL-AI-ARCH-007` | `ADAPT` | One module registry, one shared navigation composition, one Project Context composition, one `VITE_API_BASE_URL`, one direct `fetch`, and no browser-visible private Backlinks base are present. Module mocks and state are feature-private. `FU-004` proves the Gateway and a non-Backlinks Audit probe remain available after Backlinks stops. | Shared shell ownership is reduced, Website Projects remains inside Backlinks, and the existing port-4174 entry is preserved. The isolation evidence is disposable shared-runtime proof, not deployed product E2E. | Completed adaptations: `BL-AI-ARCH-007` and `BL-AI-ARCH-008-FU-004`. | Frontend typecheck, lint, and build exit `0`; port `4174` returns HTTP `200`; isolation result is health `200`, Audit `200`, Backlinks `503`. |

No reviewed group requires `REPLACE`. No duplicate Backlinks state machine, SQL
writer, forged platform context implementation, or second browser API base was
found.

## Verification

### Backlinks Core

| Command | Result |
|---|---|
| `npm ci` | exit `0`; lock installed; audit reported 0 vulnerabilities |
| `npm run typecheck` | exit `0` |
| `npm run lint` | exit `0` |
| `npm run source:manifest:check` | exit `0`; 20 records |
| `npm run dependencies:allowlist` | exit `0` |
| `npm run licenses:check` | exit `0`; 603 packages |
| `npm run sbom:backlinks` | exit `0`; 591 exact components; 0 sensitive fields |
| `npm run openapi:backlinks:check` | exit `0`; 8 paths |
| `npm run migration:backlinks:check` | exit `0` |
| `npm audit --omit=dev` | exit `0`; 0 vulnerabilities |
| `npm run test:backlinks:unit` | exit `0`; 78/78 |
| `npm run test:backlinks:api` | exit `0`; 46/46 |
| `npm run test:backlinks:contract` | exit `0`; 49/49 |
| `npm run test:backlinks:security` | exit `0`; 88/88 |
| default serial Integration | exit `0`; 64 passed, 13 environment-gated skips |
| PostgreSQL-enabled serial Integration | exit `0`; 77/77 against disposable PostgreSQL `17.10`, including disposable Temporal execution |
| Resilience with explicit empty-suite allowance | exit `0`; no test files |

The explicit Resilience allowance proves only that the current suite is empty.
It is not resilience or product E2E evidence.

### Platform Gateway And Shared Contracts

| Check | Result |
|---|---|
| Python Ruff plus pytest in Python 3.13 container | exit `0`; Ruff passed; pytest 11/11 |
| `scripts/check_shared_contracts.py` | exit `0`; 8 public paths, 0 cross-module events, 1 module Task Queue |
| FastAPI runtime route inspection | `PROVEN`: exactly 7 Backlinks adapters; aggregate OpenAPI remains generated separately and runtime routes are excluded from duplicate schema generation |
| Gateway forwarding tests | `PROVEN`: forged context stripped/rejected, project binding enforced, query/command forwarded once, idempotency required, transport failure mapped to exact 503, and no SQL fallback |
| Private Backlinks bootstrap tests | `PROVEN`: 8 existing operations, no CORS, loopback-default bind, non-loopback rejection, real listener start, and graceful idempotent stop |

### Frontend And Runtime

| Check | Result |
|---|---|
| `npm run typecheck` in `frontend` | exit `0` |
| `npm run lint` in `frontend` | exit `0` |
| `npm run build` in `frontend` | exit `0`; existing chunk-size warning only |
| API transport scan | one `VITE_API_BASE_URL`, one direct `fetch`, no private Backlinks base |
| `http://127.0.0.1:4174/` | HTTP `200`; listener PID `21288` |
| Disposable shared runtime | routes `7`; command count `1`; Platform health after stop `200`; Audit probe after stop `200`; Backlinks after stop exact `503 BACKLINKS_UNAVAILABLE` |
| Temporary containers and networks | removed; no residual ARCH-008 PostgreSQL, Gateway, Backlinks, Temporal, or test network |

## Resolved Follow-up Tasks

| Task | Result | Evidence |
|---|---|---|
| `BL-AI-ARCH-008-FU-001` | `DONE` | Required repository-local roles are staffed by `tianyulong23-dotcom`; affected paths, approval date, conflict handling, and conditional verification are recorded in `shared-surface-review-2026-07-24.md`. No authenticated GitHub ownership or independent review is claimed. |
| `BL-AI-ARCH-008-FU-002` | `DONE` | The private Fastify factory registers the existing eight operations, has no browser CORS, defaults to loopback, rejects non-loopback unless explicitly authorized, starts a real listener, and stops gracefully. |
| `BL-AI-ARCH-008-FU-003` | `DONE` | FastAPI registers exactly seven public Backlinks adapters, resolves and signs Platform context, enforces project binding, forwards once, requires idempotency for reject/refill, maps transport failure to exact 503, and contains no Backlinks SQL fallback. |
| `BL-AI-ARCH-008-FU-004` | `DONE` | A disposable cross-process test proved seven Gateway routes and one command execution; after stopping Backlinks, Platform health and a test-only Audit probe remained `200`, while Backlinks returned exact `503 BACKLINKS_UNAVAILABLE`. |

There are no unresolved P0 or P1 items in the reviewed local/shared-repository
scope. Persistent deployment, production credentials, production database
application, backup/restore operations, and independent GitHub review remain
outside this gate and are not claimed as completed.

## Shared File Review

The shared Gateway, aggregate OpenAPI, and Backlinks private API bootstrap were
modified only within the paths approved by
`shared-surface-review-2026-07-24.md`. That record's required verification is
satisfied by the results above. No frontend source was modified by the
follow-ups, and the existing one-public-base rule was reverified.

The historical blocked ARCH-008 result remains in the state file. This rerun
adds a new `DONE` result and does not rewrite `BL-AI-001` through
`BL-AI-073`. `BL-AI-074` is allowed by the gate but was not executed.
