# Backlinks Legacy Inventory

> Task: `BL-AI-195`
> Inventory date: `2026-07-30`
> Scope: old Backlinks backend skeletons, Backlinks business mocks, and
> mock-looking test support
> Change rule: inventory only; this task deletes no code

## Decision Rules

- `KEEP`: the path is an active production boundary or required test support.
- `REPLACE`: the legacy behavior has already been replaced, but historical
  evidence or an owner-controlled remnant remains.
- `DELETE`: the item has no active consumer owner, every replacement condition
  is met, and `BL-AI-196` may remove only the listed path.
- `BLOCKER`: a dependency, shared-path owner, capability decision, or written
  reference prevents deletion.
- "Consumer owner" means a current runtime, build, or test consumer. "Path
  authority" records repository governance and does not invent a consumer.
- Documentation that records historical file names is evidence, not an
  executable reference. `BL-AI-196` must still prove zero source/build/test
  references for every deleted item.

## Inventory

| Item | Current references and facts | Consumer owner | Path authority | Decision | Deletion condition |
|---|---|---|---|---|---|
| `backend/core/**` | Private Fastify Backlinks Core, migrations, repositories, Temporal workflows, tests, generated contracts, and release evidence are active. It is the sole Backlinks business authority behind the public Gateway. | Backlinks runtime and release gates | `ROLE-BACKLINKS`; assignee `tianyulong23-dotcom` | `KEEP` | Not deletable by Phase 10 cleanup. |
| `backend/api/**` | Active public FastAPI Platform Gateway. It owns public health, authentication/context resolution, aggregate OpenAPI composition, and Backlinks proxy routes. ADR-BL-0003 supersedes the earlier empty-skeleton assumption. | Platform API runtime, frontend public API, and shared contracts | `ROLE-PLATFORM-API`; assignee `tianyulong23-dotcom` | `KEEP` | Delete only through a future shared-platform topology decision after all public routes have another accepted owner. This condition is not met. |
| `backend/workers/**` | Generic Python CLI registry for `analysis`, `ai`, `integration`, and `publish`; no `Backlink*Workflow` or `Backlink*Activity` implementation was found. Root README still documents its launch command. | No Backlinks consumer; reserved shared Worker composition | `ROLE-PLATFORM-WORKERS`; affected module review required | `BLOCKER` | Requires Platform Worker owner review, removal from shared startup documentation, and proof that no non-Backlinks module uses the registry. `BL-AI-196` may not delete it. |
| `backend/crawler/**` | Active shared Go Crawler with static fetch, SSRF controls, robots/rate/size limits, object-store evidence, Temporal bindings, and the sole conditional Browser implementation. Backlinks consumes only `crawler.evidence.v1`. | Crawler runtime and Backlinks/Audit evidence consumers | `ROLE-CRAWLER`; named human `UNKNOWN` | `KEEP` | Not a legacy Backlinks skeleton. |
| `backend/browser-worker/**` | TypeScript capability-only package with no `start` script. No source consumer of `workerCapabilities` exists outside the package. A Rod-based implementation exists in the shared Go Crawler, but Browser capability remains conditionally allowed and the root README still documents this package. | No active runtime consumer | `ROLE-BROWSER-WORKER`; named human `UNKNOWN` | `BLOCKER` | Requires an explicit Browser capability retirement decision, Crawler-owner review, README/startup cleanup, and confirmation that no module needs the isolated Playwright adapter. Browser being default-off is not capability retirement. `BL-AI-196` may not delete it. |
| `frontend/src/features/outreach/mock-data.ts` | Defines `initialRecommendations`, `initialOpportunities`, local draft lifecycle builders, legacy assessments, and local placement candidates. No production source imports this file. Recommendations and Opportunities source tests explicitly reject the old seeds/builders, and all routed Backlinks pages now use generated or generated-derived API clients. Historical baseline documents mention the path but do not execute it. | `NONE`; zero runtime/build/test consumers | `ROLE-BACKLINKS`; assignee `tianyulong23-dotcom` governs the containing path | `DELETE` | Conditions are met: generated-client cutover through `BL-AI-188`, full standard states through `BL-AI-189`, desktop/mobile/a11y gates through `BL-AI-191`, and zero source imports. `BL-AI-196` may delete exactly this file and must prove the named symbols and import paths are absent. |
| Removed Backlinks manual previews and send review fixture: `frontend/src/features/outreach/{gmail/send-review-sheet.tsx,links/manual-preview.*,reports/manual-preview.*,settings/manual-preview.*}` | These tracked files are already removed by the corresponding Phase 10 page cutovers. Source acceptance tests verify the protected routed pages do not fall back to them. | None after completed replacement | `ROLE-BACKLINKS` | `REPLACE` | Replacement is complete. The existing deletions belong to `BL-AI-185`, `BL-AI-187`, and `BL-AI-188`; `BL-AI-196` must not broaden or recreate them. |
| `backend/core/src/modules/backlinks/adapters/{ai,dataforseo,gmail}/*fake*.ts` | Deterministic contract/test adapters selected only by explicit local configuration. They preserve default-off provider behavior and prevent real Gmail, DataForSEO, and AI calls in tests. | Core contract and safety tests | `ROLE-BACKLINKS` | `KEEP` | Remove only when an equivalent deterministic fake passes the same contracts. They are not production business mocks. |
| `backend/core/test/fixtures/mail/**` | Malicious, malformed, nested, and multipart mail fixtures exercise parser and sanitizer security behavior. | Mail security and contract tests | `ROLE-BACKLINKS` | `KEEP` | Not deletable while the parser/sanitizer contracts use them. |

## BL-AI-196 Approved Delete Set

Only this path is approved:

```text
frontend/src/features/outreach/mock-data.ts
```

No backend directory is approved for deletion. In particular, `backend/api`,
`backend/workers`, `backend/crawler`, and `backend/browser-worker` must remain.

## Evidence

The inventory used these repository-local checks:

```powershell
rg -n '@/features/outreach/mock-data|./mock-data|../mock-data' frontend/src
rg -n 'initialRecommendations|initialOpportunities|createLocalDemoDraftFoundation' . `
  --glob '!frontend/src/features/outreach/mock-data.ts' --glob '!**/node_modules/**'
rg -n 'workerCapabilities|seo-browser-worker|render-page|capture-dom|capture-screenshot' . `
  --glob '!backend/browser-worker/**' --glob '!**/node_modules/**'
rg -n -i 'backlink|outreach|gmail|dataforseo|browser' backend/workers
git ls-files -- backend/api backend/workers backend/crawler backend/browser-worker `
  frontend/src/features/outreach/mock-data.ts
```

Observed results:

- zero production imports of the Outreach mock file;
- only negative source-test assertions mention its exported seed/builder names;
- zero code consumers of the TypeScript Browser Worker capability list;
- zero Backlinks/provider identifiers in the Python Worker source;
- the FastAPI Gateway and Go Crawler have active source, contract, and test
  consumers;
- no code was deleted by `BL-AI-195`.

## BL-AI-196 Result

`BL-AI-196` deleted only the approved
`frontend/src/features/outreach/mock-data.ts` file. Before deletion it had 472
lines and SHA-256
`184660d61e6818e6b776426f3d563c7b4a9fa8633789af328968819480bb8b46`.

Post-deletion verification established:

- zero source, build, or test references to the deleted path;
- the old seed/builder names remain only in three negative source-test
  assertions;
- the complete Outreach source suite passed 40/40;
- frontend typecheck, ESLint, and production build exited 0;
- the deleted file remained absent after all gates;
- a 327-record status/content-hash baseline outside the approved inventory and
  Canonical State paths was byte-identical after deletion and verification;
- no backend directory, shared capability package, or other frontend module
  was deleted or changed by `BL-AI-196`.
