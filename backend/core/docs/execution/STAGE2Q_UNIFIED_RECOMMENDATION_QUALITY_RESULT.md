# STAGE2Q_UNIFIED_RECOMMENDATION_QUALITY_RESULT

## Final Status

`STAGE2Q_BLOCKED_TERRA_PLAN_NOT_CONSUMED_AND_NO_VISIBLE_V4_CANDIDATE`

This status supersedes the earlier runtime conclusions retained below as
historical execution evidence.

## 2026-08-21 ElephTV Terra Rerun

### Runtime And Identity

- HEAD: `2092d0da79cf8b126421369a9ca9db7fd4acd503`
- Build ID: `local-product-0056a77938f1b698b96c1916`
- Source fingerprint:
  `0056a77938f1b698b96c1916b7ff27c7be1048e2b2d2239fd2d85f6998adfb2d`
- Artifact fingerprint:
  `e4b76398533f4ca520ab2c91334226870da055bb37697ea31dd0115766cc5a68`
- Build identity check: `PASS`
- Final runtime: `maintenance`, Worker `quiesced`, business consumers disabled.
- Final DataForSEO state: `unavailable/explicit_block`.
- AI remained configured and available, but no further AI or DataForSEO call is
  authorized after the single public refill completed.

### Public Refill Identity

- Project: `68299b17-33d6-4993-b106-cf24f1f880bc`
- Context: `c9a7899d-e71e-429d-af0b-b718d352cda1`
- Generation: `1`
- Refill/operation: `dab88b5a-7988-4576-9199-818f596563ed`
- Job: `3b886861-eca9-47af-88e1-52a23f74aaf6`
- Outbox: `be7088a0-1259-496e-acef-726c1a996d00`
- Public idempotency key:
  `stage2q-elephtv-terra-20260821-20260821042011458`
- Target/high watermark: `10`; low watermark: `0`. The run did not use the
  retired fixed `9/10` contract.
- Terminal state: `partial_success / paused_budget / PAUSED_BUDGET`.
- Outbox terminal state: `published`, attempt `1`.
- Recovery owner: `backlinks-worker:51156:recovery`.
- Persisted commercial operation authorization: maximum `6` paid calls and
  `USD 1.00`, bound to the same job, tenant, project, context and generation.

The public authorization/operation chain therefore did not remain blocked. It
created the formal operation, preserved the binding through reservation and
workflow execution, and produced settled Provider ledger entries. No second
job was created and no failed job was rearmed.

### Terra Plan

The formal AI blueprint was generated before Provider execution:

- Blueprint: `12861f9e-d200-409d-8446-c15d5afa9237`
- Generator: `AI`
- Model: `gpt-5.6-terra`
- Schema/prompt: `commercial-discovery-blueprint.v5` /
  `commercial-discovery-blueprint-prompt.v5`
- Context: `c9a7899d-e71e-429d-af0b-b718d352cda1`
- AI calls: `1`
- AI cost: `USD 0.000863`

Structured English queries:

1. `South Africa streaming service review sites`
2. `South Africa streaming service entertainment publications`
3. `South Africa TV streaming technology blogs`
4. `South Africa film and TV review publications`
5. `South Africa streaming app review websites`
6. `Cape Town streaming entertainment guides`
7. `South Africa digital entertainment industry publications`
8. `South Africa home entertainment resource sites`
9. `South Africa television and streaming guides`
10. `South Africa local streaming service comparisons`

None of these query IDs was consumed by a DataForSEO semantic discovery
request. No `BLUEPRINT_SERP_STANDARD_QUEUE` source executed. This violates the
hard rerun condition that the Terra artifact must be the lineage source for the
actual DataForSEO discovery queries.

### Free Sources And Paid Requests

The new free-first behavior did execute. Three zero-paid batches reused
`EXISTING_HISTORY`, competitor backlink-gap/referring-domain evidence and user
referring-domain history before paid qualification:

- `feeacd74-889a-4b8c-aa6b-210e96e26ec2`
- `2da6dcf9-0fcf-474f-90ec-5eaff197dad7`
- `3e414f6a-b69f-4c7c-8c7d-f86ce5afd091`

The operation then spent all six paid-call slots qualifying two existing
domains instead of reserving a candidate-producing Terra/SERP request:

| Request | Endpoint | Target | Locale | Cost |
| --- | --- | --- | --- | ---: |
| `6657d962-4b94-4b88-bec4-8dcb6da73f23` | `dataforseo_labs/google/bulk_traffic_estimation/live` | `filmlovr.com` | `en/2710` | `$0.012120` |
| `91d12d7c-bcdf-4069-99ed-343ef1d76389` | `backlinks/bulk_spam_score/live` | `filmlovr.com` | n/a | `$0.024036` |
| `779f8ef0-58ed-466e-8466-d02402aa0362` | `backlinks/bulk_ranks/live` | `filmlovr.com` | n/a | `$0.024036` |
| `f3ba7807-3daf-473c-8838-b1f0aa61d122` | `dataforseo_labs/google/bulk_traffic_estimation/live` | `episodetime.com` | `en/2710` | `$0.012120` |
| `da27ef32-4ca0-4dae-b08b-fc9c5c42cdf9` | `backlinks/bulk_spam_score/live` | `episodetime.com` | n/a | `$0.024036` |
| `ee4c3ff3-3497-4603-89bc-de8b4da42de8` | `backlinks/bulk_ranks/live` | `episodetime.com` | n/a | `$0.024036` |

All six requests succeeded and settled:

- New DataForSEO requests: `6`
- New DataForSEO cost: `USD 0.120384`
- Terra plus DataForSEO cost: `USD 0.121247`
- Reserved amount: `USD 0`
- Unknown charge: `0`
- Active lease: `0`
- Project ledger after the run: `58` Provider requests, `46` settled usage
  rows, `USD 0.832068` actual cost.

### Candidate Funnel

Across the three exact batches, the run retained `75` unique raw domains:

- `56` excluded
- `19` insufficient data
- `0` manual review
- `0` candidate ready
- `0` V4 score `>=50`
- maximum V4 score: `47.1194`
- published/visible: `0`

Highest-scoring candidates:

| Domain | V4 score | Evidence | Final result |
| --- | ---: | --- | --- |
| `filmlovr.com` | `47.1194` | traffic/spam/rank qualification completed | excluded below `50` |
| `fittyfoody.com` | `44.5982` | referring-domain lineage | excluded: zero topic relevance |
| `sergechel.info` | `44.5982` | referring-domain lineage | excluded: zero topic relevance |
| `episodetime.com` | `43.5380` | traffic/spam/rank qualification completed | excluded below `50` |
| `faildesk.net` | `40.0357` | referring-domain lineage | excluded: zero topic relevance |
| `managing.blue` | `40.0357` | referring-domain lineage | excluded: zero topic relevance |
| `pitermarx.com` | `40.0357` | referring-domain lineage | excluded: zero topic relevance |
| `betwinnermirror.com` | `36.2857` | referring-domain lineage | excluded: zero topic relevance and PBN/link-farm risk |

Other excluded domains:

`acheworry.com`, `angular-movies-a12d3.web.app`, `batizens.vn`, `besia.org`,
`bestaffiliate4u.com`, `betulcrime.com`, `blocktopiamc.com`, `brapodd.se`,
`brenthill.com`, `browncat.org`, `chrisfinke.com`, `citazine.fr`,
`clientcentral.info`, `crunchbang.net`, `easiio.com`, `ecovs.cn`,
`flihk.org`, `gloss.net.au`, `goodpower.se`, `gravos.blogspot.com`,
`grupoalpes.com.br`, `inclusive-it.org`, `insolvencyguardian.com.au`,
`iwebchk.com`, `kimiasamane.com`, `linktoplist.com`, `mampirlah.com`,
`miheeff.com`, `moderner.com`, `ododuorpremium.com`, `omidfile.com`,
`onlinehd.info`, `poisonflowers.net`, `popzila.com`, `reviews4.info`,
`shia-tools.com`, `stathub.org`, `tarocchisibille.com`, `tax1one.com`,
`thammybaoan.com`, `theforbestimes.com`, `thestardustmag.com`, `vflyai.com`,
`vnurl.info`, `way2check.cv`, `widgetsmonster.com`, `windechime.com`,
`wowthemez.com`.

Insufficient-data domains:

`ahrefs-links.com`, `authorityprodirectory.com`,
`backlinkboostdirectory.com`, `craiggarner.net`, `dltech.forum`,
`famguytoday.blogspot.com`, `fhmaustralia.com`, `findingsmarket.co`,
`global-ranks.pages.dev`, `hsh-crafts.com`, `idealnet.com`,
`linkboostdirectory.com`, `nuekin.com`, `powerlinkdirectory.com`,
`sondizi.com`, `tayfunmovie.herokuapp.com`, `torrentkk13.com`,
`worldseodirectory.com`, `youtube-screenshot.com`.

Every persisted candidate in this rerun came from
`VERIFIED_COMPETITOR_REFERRING_DOMAINS`; `betulcrime.com` also retained
`USER_REFERRING_DOMAINS` lineage. The Terra query plan produced no candidate
lineage because it was not executed.

### GET And UI Evidence

The formal recommendation GET returned HTTP `200` with:

- `items=[]`
- `presentationState=current`
- no visible V4 recommendation.

The live UI displayed the same result:

- `部分完成`
- `本轮授权预算已用尽。当前保留 0 个已验证匹配网站。`
- raw candidates `25`
- verified matches `0`
- contacts ready `0`
- no recommendation card.

Screenshot:
`output/playwright/stage2q-elephtv-terra-rerun-empty.png`

Screenshot SHA-256:
`B290229506CC464E8F51960B40D72B5B4CBB1CC43CD382757E91CD6F7E1575F8`

The UI read model displayed `$0.0787`, while the authoritative ledger for this
job settled at `USD 0.120384`. This is a remaining cost-reporting discrepancy;
the ledger value is the accounting source of truth.

The contact-not-a-gate rule was not exercised by a successful runtime
candidate because no V4 candidate reached `50`. It therefore cannot be claimed
as live acceptance evidence from this run.

### Side Effects And Conclusion

- New Opportunities: `0`
- Gmail/send intents/messages: `0`
- Placements: `0`
- Indexification submissions: `0`
- Unknown charge/reserved usage/active lease: `0`
- No second refill job and no replay of a failed job.

The formal authorization/open-switch path was successfully exercised; it is
not the remaining blocker. The run failed its quality acceptance because:

1. the Terra artifact was generated but not consumed by DataForSEO;
2. all six paid calls were spent on qualification of existing domains;
3. no semantic discovery request ran;
4. no realistic V4 candidate reached `50` or became visible in GET/UI.

This is neither `REAL_PROVIDER_VERIFIED` nor Provider supply exhaustion. The
next product correction is the bounded execution-order contract: when the pool
has no eligible/published candidate and a Terra semantic source is planned,
existing-candidate qualification must not consume every paid-call slot before
at least one candidate-producing semantic request executes.

The current V4 recommendation GET returns no visible items. The UI now agrees:

- `items=[]`
- `visibleMatchCount=0`
- `publishedCount=0`
- the top metric displays `已验证匹配 0`
- no recommendation card is rendered

The previously displayed `2` was not a visible-current-pool count. It came from
immutable V4 qualification/visibility facts for `amazon.com` and `github.com`
that remained after both current inventory rows became `NOT_PUBLISHED` and
their current V4 commercial candidates became ineligible. It was not a V3
fallback and not a non-current generation aggregate.

The read model now derives the visible metric from current V4 published
inventory joined to a current V4 eligible commercial candidate. Immutable
historical facts remain available for audit, but no longer inflate the current
visible-match metric.

This correction is runtime-verified, but the broader quality acceptance remains
incomplete because the current pool contains no realistic, eligible V4
candidate. This result is not Provider supply exhaustion.

## Source-Plan Blocker And Repair

The current completed batch
`041d351d-eadf-4a7d-a6cf-bbd7f4aa9211` reused five settled artifacts:

- one competitor-seed artifact;
- one user-site referring-domain history artifact;
- three competitor page-backlink artifacts.

It contains no `BLUEPRINT_SERP_STANDARD_QUEUE` artifact. Its 25 current
candidates all came from `VERIFIED_COMPETITOR_REFERRING_DOMAINS`; 21 were
excluded and 4 remained insufficient. Therefore this batch does not establish
Provider supply exhaustion.

The persisted deterministic Blueprint contains target-language semantic facts,
including `streaming service in sa` and `eleph tv`. The production candidate
plan nevertheless ordered its first source slots as competitor backlinks, user
referring-domain history, then semantic SERP. Under a constrained paid-call
window, the history source could consume the second slot before SERP was
executed.

The planner now orders the source buckets as competitor page evidence, semantic
SERP, then user referring-domain history. A focused regression proves that a
two-call candidate budget includes competitor evidence and semantic SERP rather
than history. Planner and discovery-service tests pass, but runtime acceptance
remains blocked until the new build executes the formal plan and either
publishes a realistic V4 candidate or records audited exhaustion for every
planned source.

## Frozen Identity

- Date: `2026-08-20`
- Repository:
  `C:\Users\DELL\Documents\缝合\john3947-seo-main`
- HEAD: `2092d0da79cf8b126421369a9ca9db7fd4acd503`
- Git porcelain count after evidence capture: `367`
- Build ID: `local-product-39adbc9d3140764d224c4273`
- Source fingerprint:
  `39adbc9d3140764d224c42733b7b149066a1b3ac68b24ee9931cb831c9baa74f`
- Artifact fingerprint:
  `541870b4db413b8c1395e8abf8e8eb89ba2d3c71bfce77c6662b85caf11d8c18`
- Build identity check: `PASS`
- Migration head: `0072`

The shared dirty worktree was preserved. No commit, push, clean, reset,
checkout, stash, or unrelated formatting was performed.

## Stage2Q Code Result

The code and migration work loaded by this build includes:

- V4 as the current recommendation publication/read-model contract.
- Immutable legacy V3 publication facts and a legacy-stale read fallback while
  a valid V4 generation is unavailable.
- A valid V4 generation taking over from the legacy fallback.
- Explicit `supplyMode=existing_evidence` reassessment without a commercial
  supply operation or Provider budget.
- Normal discovery continuing to fail closed when its provider operation
  authorization is absent.

The focused verification completed before runtime acceptance included:

- PostgreSQL recommendation-contract compatibility: `6/6` passed.
- Focused Core API/unit/integration: `18/18` passed.
- Runtime-mode tests: `21/21` passed.
- Frontend recommendation tests: `17/17` passed.
- Core and frontend TypeScript checks: passed.
- Core build and build-identity check: passed.
- Migration manifest through `0071`: passed.

No Opportunity, Gmail, Placement, Indexification, or second Backlinks profile
surface was added or changed by this closure.

## Zero-Cost Existing-Evidence Replay

The new job was created through the public recommendation refill route with:

- Project: `68299b17-33d6-4993-b106-cf24f1f880bc`
- Organization: `11111111-1111-4111-8111-111111111111`
- Workspace: `22222222-2222-4222-8222-222222222222`
- Context: `c9a7899d-e71e-429d-af0b-b718d352cda1`
- Visible generation: `1`
- Supply mode: `existing_evidence`
- Idempotency key:
  `stage2q-zero-cost-v4-reassess-20260820-2`
- Refill/operation ID: `a7ad7f96-9f13-4f10-92b1-e67447de4093`
- Job ID: `ff9a4a8e-f4d7-4078-9481-3e77a2e95ca6`
- Outbox ID: `f783ab15-5ef0-4bf5-ab3f-18d2a9b256c6`

Terminal result:

- Job status: `partial_success`
- Step: `supply_below_target`
- Outcome: `SUPPLY_FLOOR_REACHED`
- Evaluated: `0`
- Newly added: `0`
- Published from existing evidence: `2`
- Provider batch-request delta: `0`
- Provider usage-ledger delta: `0`
- Provider cost delta: `USD 0`

The old failed audit facts remain unchanged:

- Old job: `11bf2778-1563-4b39-829f-d99581f4731d`
- Old outbox: `0a5df28c-3fa3-49bb-b45b-6cf43f7dc007`
- Job remains `failed / provider_request_failed`, version `3`.
- Outbox remains `published`, attempt `1`.

They were not rearmed, edited, or reused.

## GET And UI Evidence

The official recommendation GET was read repeatedly after recovery:

- HTTP: `200`
- Item count: `2`, then `2`
- Presentation state: `current`
- Domains and scores:
  - `amazon.com`: `63.7122`
  - `github.com`: `61.0441`
- Score model: `recommendation-commercial-fit.v4`
- Publication status: `PUBLISHED`
- Contact status: `not_found`
- Outreach readiness: `contact_pending`

Repeated GET did not add candidates, jobs, outbox events, Provider requests,
leases, ledger rows, or cost.

Playwright DOM evidence showed the same two domains and rounded scores:

- `amazon.com`: `63.7`
- `github.com`: `61.0`
- Both remained visible with the no-contact state instead of being hidden.

Artifacts:

- `.playwright-cli/page-2026-08-20T11-01-06-470Z.png`
- `.playwright-cli/page-2026-08-20T11-00-56-009Z.yml`

## Paid Public Refill Attempt

A single new normal refill was created through the public product command:

- Idempotency key: `stage2q-paid-v4-discovery-20260820-1`
- Refill/operation ID: `5a3a7cb0-3f5e-475e-99b4-2ffeecd2a121`
- Job ID: `ef326b3d-b3d7-41f3-b06b-34c882b48ad2`
- Outbox ID: `f4accaa0-163e-4ded-9225-4b9b69538341`
- Context and generation: unchanged, `c9a7899d... / 1`
- Outbox terminal: `published`, attempt `1`
- Job terminal: `failed / provider_request_failed`
- Retry count: `0`
- Root cause: `UNKNOWN_INTERNAL`
- Recovery: `CONTACT_SUPPORT`
- `providerCallOccurred`: `false`

The attempt produced:

- New provider batch requests: `0`
- New provider usage rows: `0`
- New actual cost: `USD 0`
- New reserved/unsettled/unknown-charge rows: `0`
- Open provider leases: `0`

The failure occurred before DataForSEO execution. It is therefore not Provider
supply exhaustion and cannot be reported as
`STAGE2Q_PASS_CODE_PROVIDER_SUPPLY_EXHAUSTED`.

## Unique Product Gap

The public route
`POST /api/v1/projects/:project/backlinks/recommendation-refill-jobs`
accepts:

- context version;
- visible generation;
- optional recovery `operationId`;
- optional `supplyMode=existing_evidence`.

It does not accept or obtain the provider-budget grant supported by the
application command. Consequently:

1. Existing-evidence reassessment works without Provider authorization.
2. A normal new paid refill can be queued and dispatched.
3. The normal workflow cannot establish its required authorized commercial
   supply operation and fails before any Provider call.

The single required follow-up is a formal product/operations command that
creates and audibly binds that authorization to a new normal refill. It must
preserve the existing tenant, context, generation, idempotency, ledger, lease,
and unknown-charge controls. The failed job above must remain immutable audit
history; a future retry must use a new job and idempotency identity.

## Provider And Side-Effect Accounting

- Provider requests added by the zero-cost replay: `0`
- Provider requests added by the paid attempt: `0`
- Cost added by both attempts: `USD 0`
- Current Provider usage-ledger total: `10` settled rows
- Current historical actual cost: `141324` micros (`USD 0.141324`)
- Reserved/unsettled/unknown-charge rows: `0`
- Open leases: `0`
- Gmail sends/syncs: `0`
- AI calls: `0`
- Browser business-provider calls: `0`
- Opportunities created: `0`
- Placement or Indexification submissions: `0`
- Manual database writes: `0`

## Final Runtime

The repository's official `scripts/dev-up.ps1` completed successfully and
restored the safe runtime:

- Runtime: `maintenance`
- Business consumers running: `false`
- Core build: `local-product-8f2cc01c676151e7981967cd`
- Worker build: `local-product-8f2cc01c676151e7981967cd`
- Worker mode: `quiesced`
- PostgreSQL ready: `true`
- Temporal ready: `true`
- DataForSEO: `unavailable / explicit_block`
- AI: `disabled`
- Provider leases or unsettled accounting: none

The task stopped at this boundary. No additional refill or Provider attempt was
started.

## 2026-08-20 Visible-Match Metric Correction

### Root Cause

`recommendations.query.ts` calculated the headline `visibleMatchCount` from
the latest immutable recommendation visibility facts. Those facts are
appropriate audit evidence, but they can outlive a current publication or
commercial-candidate decision. In this case they still contained two V4
visible decisions while:

- both current inventory records were `NOT_PUBLISHED`;
- both current V4 commercial candidates were ineligible;
- the current recommendation list correctly returned `items=[]`.

The query now counts only current-generation V4 published inventory that also
has a matching current V4 eligible commercial candidate. Historical immutable
facts remain unchanged.

### Changed Files

- `src/modules/backlinks/application/queries/recommendations.query.ts`
- `test/backlinks/integration/recommendation-contract-compatibility.test.ts`
- `test/unit/stage2q-recommendation-contract.test.ts`

The PostgreSQL regression keeps the stale immutable V4 facts in place, changes
the current candidate and inventory to ineligible/not-published, and proves the
headline count becomes zero without deleting history.

### Verification

- Stage2Q recommendation contract unit tests: `6/6` passed.
- PostgreSQL recommendation contract compatibility: `7/7` passed.
- Recommendation API route tests: `12/12` passed.
- Core TypeScript check: passed.
- Core build: passed.
- Build identity: passed.

Loaded identity:

- Build ID: `local-product-39adbc9d3140764d224c4273`
- Source fingerprint:
  `39adbc9d3140764d224c42733b7b149066a1b3ac68b24ee9931cb831c9baa74f`
- Artifact fingerprint:
  `541870b4db413b8c1395e8abf8e8eb89ba2d3c71bfce77c6662b85caf11d8c18`

Repeated runtime GETs returned identical results:

- `visibleMatchCount=0`
- `publishedCount=0`
- `fitCount=2` as a non-visible progress/evidence aggregate
- `itemCount=0`
- `presentationState=current`
- `providerActualCostMicros=78732`
- `providerPaidCallCount=3`
- `providerUnknownChargeCount=0`

The UI displayed `已验证匹配 0`, rendered no recommendation cards, and retained
the provider-cost display of `$0.0787`.

### Provider And Cost Audit

No Provider request, lease, usage, or cost was created by this correction or
its GET/UI verification.

The current-generation inventory cost of `78732` micros (`USD 0.078732`) is the
sum of these three discovery requests:

- DataForSEO Labs competitors-domain live: `24000` micros.
- Backlinks live: `27600` micros.
- Referring-domains live: `27132` micros.

The separate most-recent qualification job cost was `60192` micros
(`USD 0.060192`) across bulk traffic, spam, and rank requests. It is retained
in the project-wide provider ledger and is not added to the current-generation
inventory metric a second time.

Project-wide accounting after repeated GET/UI reads:

- Provider requests: `40` total, `28` succeeded, `12` failed.
- Usage ledger: `28` settled rows.
- Actual historical cost: `528348` micros (`USD 0.528348`).
- Reserved, unsettled, or unknown-charge rows: `0`.
- Open acquired leases: `0`.
- GET/UI verification delta: `0` requests and `USD 0`.

### Runtime Boundary

- Runtime: `maintenance`
- Business consumers running: `false`
- Core and Worker build:
  `local-product-39adbc9d3140764d224c4273`
- Worker mode: `quiesced`
- DataForSEO: `unavailable / explicit_block`
- AI: `disabled`

No new refill, Provider call, Opportunity, Gmail action, Placement, or
Indexification action was started.

## 2026-08-20 Final Six-Call Source-Exhaustion Acceptance

### Verdict

`STAGE2Q_PASS_CODE_PROVIDER_SUPPLY_EXHAUSTED`

The final authorized operation exercised semantic candidate discovery before
qualification, reused the previously settled active-link and competitor
artifacts, and produced no V4 candidate that passed both the score threshold
and the current placement-quality gates. No large platform was accepted as a
substitute result.

### Loaded Build And Authority

- HEAD: `2092d0da79cf8b126421369a9ca9db7fd4acd503`
- Build ID: `local-product-a787f6aaff2ce47d68f7ec52`
- Source fingerprint:
  `a787f6aaff2ce47d68f7ec525b4bc063c4557ae31c0cccb8ab14a71c1f9c401e`
- Artifact fingerprint:
  `5efb26ed8d63eaee7bf96427805111a39b21a4d560b83458ac6ca4bcaf53df69`
- Context snapshot: `c9a7899d-e71e-429d-af0b-b718d352cda1`, version `8`
- Profile version: `a72a42ed-6396-47ad-aa86-760900ee127c`
- Promotion target version:
  `51c3c8c5-76a1-4461-b973-7825afad484a`
- Generation input pin: `97731aa6-7307-543d-a8a2-e6b4bc60b9ba`
- Visible generation: `1`
- Locale: `en / ZA`

### Operation Identity And Terminal State

- Job: `20392532-72a1-4798-a79a-1fb622e015e8`
- Public idempotency key:
  `stage2q-paid-v4-semantic-discovery-20260820-6call-1`
- Commercial refill operation:
  `9719020c-804d-47da-9a54-977a4dc3af47`
- Supply operation:
  `commercial-refill-operation:20392532-72a1-4798-a79a-1fb622e015e8`
- Outbox: `18e82e60-aa2e-4f19-b347-95d0b5885fd1`
- Batch: `c22c52ab-717e-4d75-b366-7f4555747f75`
- Authorization: at most `6` paid calls and `USD 1.00`
- Terminal job state: `partial_success / paused_budget`
- Terminal batch state: `paused`
- Outbox: `published`, attempt `1`, recovery owner
  `backlinks-worker:11888:recovery`

### Exact New DataForSEO Requests

| # | Endpoint | Target | Locale | Cost |
|---|---|---|---|---:|
| 1 | `/v3/serp/google/organic/task_post` | `streaming service in sa ZA local or regional publication` | `en / 2710` | USD 0.000600 |
| 2 | `/v3/serp/google/organic/task_post` | `streaming service in sa ZA adjacent industry publication` | `en / 2710` | USD 0.000600 |
| 3 | `/v3/serp/google/organic/task_post` | `eleph tv ZA blog` | `en / 2710` | USD 0.000600 |
| 4 | `/v3/dataforseo_labs/google/bulk_traffic_estimation/live` | five V4 enrichment-eligible domains | batch | USD 0.012600 |
| 5 | `/v3/backlinks/bulk_spam_score/live` | the same five domains | batch | USD 0.024180 |
| 6 | `/v3/backlinks/bulk_ranks/live` | the same five domains | batch | USD 0.024180 |

Qualification targets were `jake.eu`, `marketsandmarkets.com`, `sajim.co.za`,
`screenshots.wiki`, and `sentech.co.za`. All six requests settled. The total
increment was `62760` micros (`USD 0.062760`).

The executed source lineage comprised:

- `EXISTING_HISTORY`, reused without a new Provider request.
- `VERIFIED_COMPETITOR_BACKLINK_GAP`, used as a seed source.
- `VERIFIED_COMPETITOR_REFERRING_DOMAINS`, with active-link artifacts.
- `USER_REFERRING_DOMAINS`, with persisted lineage.
- `BLUEPRINT_SERP_STANDARD_QUEUE`, executed by the three semantic queries
  above before qualification.

Candidate-producing sources contributed:

- Semantic SERP: `11` domains, `7 excluded`, `4 insufficient_data`.
- Competitor referring domains: `11` domains, `9 excluded`,
  `2 insufficient_data`.
- Combined user and competitor referring lineage: `3` domains, all excluded.

### Complete Current-Batch V4 Candidate Audit

| Domain | V4 score | State | Primary reason |
|---|---:|---|---|
| `marketsandmarkets.com` | 54.6701 | excluded | Topic/keyword match, but no current topic-linked placement path |
| `sajim.co.za` | 54.4975 | excluded | Topic/keyword match, but no current topic-linked placement path |
| `sentech.co.za` | 49.3944 | excluded | Below threshold and placement path lacks topic evidence |
| `screenshots.wiki` | 47.8684 | excluded | Below threshold and placement path lacks topic evidence |
| `mummila.net` | 47.5357 | excluded | Zero topic relevance |
| `jake.eu` | 47.4684 | excluded | Below threshold and placement path lacks topic evidence |
| `buzzshrink.website` | 47.2952 | excluded | Below threshold and placement path lacks topic evidence |
| `backlinktime.com` | 44.9107 | excluded | Zero topic relevance and PBN/link-farm hard gate |
| `bazerdaily.com` | 44.5982 | excluded | Zero topic relevance |
| `macroevolution.net` | 37.6334 | excluded | Market/language mismatch and no topic-linked placement path |
| `medtechcah.com` | 37.2279 | excluded | Market/language mismatch and no topic-linked placement path |
| `fabricdata.com` | 36.7352 | excluded | Below threshold |
| `gamicos.com` | 36.6386 | excluded | Market/language mismatch and no topic-linked placement path |
| `winniekidsclothes.com` | 36.0714 | excluded | Zero topic relevance and market/language mismatch |
| `lamer.cz` | 35.5357 | excluded | Zero topic relevance and market/language mismatch |
| `lucintel.com` | 34.5798 | excluded | Below threshold |
| `springer.com` | 33.0798 | excluded | Below threshold; no current page-level placement evidence |
| `theglobe.net` | 32.3214 | excluded | Zero topic relevance and PBN/link-farm hard gate |
| `hippo.co.za` | 31.4156 | excluded | Zero topic relevance |
| `cput.ac.za` | n/a | insufficient_data | Semantic, placement, market, and quality evidence incomplete |
| `dailymaverick.co.za` | n/a | insufficient_data | Semantic, placement, market, and quality evidence incomplete |
| `eleph-tv.co.za` | n/a | insufficient_data | Semantic, placement, market, and quality evidence incomplete |
| `fluther.com` | n/a | insufficient_data | Semantic and market evidence incomplete |
| `nikoniarze.pl` | n/a | insufficient_data | Semantic and market evidence incomplete |
| `researchgate.net` | n/a | insufficient_data | Semantic, placement, market, and quality evidence incomplete |

Final distribution: `25 raw`, `19 excluded`, `6 insufficient_data`,
`0 candidate_ready`, and `0 published`. `amazon.com` and `github.com` are
absent from the current V4 candidate set and visible pool.

### Ledger And Side Effects

Frozen baseline:

- Provider requests: `46`
- Settled usage rows: `34`
- Settled cost: `648924` micros (`USD 0.648924`)
- Reserved, unknown-charge, and active lease counts: `0`

Terminal totals:

- Provider requests: `52`
- Settled usage rows: `40`
- Settled cost: `711684` micros (`USD 0.711684`)
- Reserved, unknown-charge, and active lease counts: `0`

No Opportunity, Gmail, mail, Placement, or Indexification action was created.
No score, candidate, job, outbox, or ledger row was manually altered.

### GET And UI Acceptance

The formal recommendation GET returned:

- `items=[]`
- `presentationState=current`
- `visibleMatchCount=0`
- `rawCandidateCount=25`
- `publishedCount=0`
- `productState=partial_exhausted`
- `terminalState=PAUSED_BUDGET`

The UI displayed `已验证匹配 0`, no recommendation cards, the retained
`$0.0787` generation discovery cost, and the partial-completion/budget message.
This matches the V4 visible pool and does not expose historical Amazon/GitHub
facts as current recommendations.

Read-only screenshot:

`output/playwright/stage2q-final-empty-v4-pool.png`

SHA-256:
`02BABFC1E609D6F4BE155EEBA75ECD4E216565602602BA1F00B86FB31C05B77C`

Repeated GET and UI reads produced no candidate, job, outbox, Provider,
usage, lease, or cost increment.

### Final Runtime Boundary

- Runtime: `maintenance`
- Business consumers running: `false`
- Core and Worker build:
  `local-product-a787f6aaff2ce47d68f7ec52`
- Worker mode: `quiesced`
- DataForSEO: `unavailable / explicit_block`
- AI: `disabled`

The code and formal source chain completed correctly, but the executed,
auditable source supply did not yield a realistically actionable V4
recommendation under the unchanged `>=50` admission and placement-quality
rules. No further paid operation was started.

## 2026-08-21 Terra Planner-To-SERP Lineage Repair

Status: `CODE_FIX_PASS_RUNTIME_ACCEPTANCE_PENDING`.

The latest failed acceptance exposed a narrower product defect: Terra produced
ten structured discovery queries, but the semantic DataForSEO calls were not
bound to the persisted Blueprint/query identity. The Blueprint was persisted
only after candidate discovery, so a provider request could not prove that it
consumed a specific Terra query artifact.

The durable repair now:

- persists a newly generated Blueprint before semantic candidate discovery;
- assigns each semantic query a deterministic query ID bound to the persisted
  Blueprint ID;
- includes that lineage in provider request persistence and normalized
  discovery artifacts;
- restores the same lineage during accepted-task recovery and includes it in
  the request fingerprint;
- keeps internal lineage metadata out of the payload sent to DataForSEO; and
- remains backward compatible with historical request/artifact JSON that has
  no planner lineage.

Focused verification:

- `commercial-discovery-source.test.ts`: 12 passed;
- `commercial-recommendation-discovery.service.test.ts`: 18 passed;
- combined focused suite: 30 passed;
- TypeScript typecheck: passed;
- build: passed;
- build identity check: passed.

New build identity:

- build ID: `local-product-42a6b75e030cd1ac8b7af6c3`;
- source fingerprint:
  `42a6b75e030cd1ac8b7af6c3221eab2e0a82e13ce9f00dd7205f9d261f2fd0c6`;
- artifact fingerprint:
  `39018cb47f4d8b19cc2314941ebcef668afe915eee5ec0587b6cc012b12dc62b`.

This repair stage created no refill, started no service or Worker, and made no
AI/DataForSEO/Gmail/Browser call. Provider request, usage, lease, and cost
deltas are therefore zero.

`STAGE2Q` is not complete: the last formal GET/UI result is still zero visible
V4 candidates and must not be reported as success. The next real acceptance
requires loading this build and running exactly one new bounded public refill;
that run must show the persisted Terra Blueprint/query lineage on the semantic
DataForSEO requests and then produce either a realistic visible V4 candidate
or complete auditable source-exhaustion evidence.

## 2026-08-21 ElephTV Terra Semantic Runtime Acceptance

Task:
`STAGE2Q_ELEPHTV_TERRA_SEMANTIC_RUNTIME_ACCEPTANCE`.

Final classification:

- `IMPLEMENTED: PASS`
- `TESTED: PASS`
- `REAL_PROVIDER_VERIFIED: PASS`
- `REAL_PROVIDER_SUPPLY_EXHAUSTED: NOT_APPLICABLE`
- `BLOCKED: NO`

This classification is based on a real, single-refill product run, not on code
or Provider-request success alone. Persisted ElephTV Website Project data
produced a Terra Blueprint; four selected Terra queries were consumed by real
DataForSEO semantic SERP discovery; real domains were persisted and evaluated
under V4 at the unchanged threshold of `50`; and eight recommendations were
visible and identical in the formal GET and UI. The business acceptance is
anchored by realistically cooperative current-Terra sites including
`saweddings.co.za`, `splingmovies.com`, `entertainment-online.co.za`, and
`nfvf.co.za`, rather than by Amazon, GitHub, or another mega-platform.

### Single Refill And Recovery Identity

- Website Project:
  `68299b17-33d6-4993-b106-cf24f1f880bc`
- Organization:
  `11111111-1111-4111-8111-111111111111`
- Workspace:
  `22222222-2222-4222-8222-222222222222`
- Project context version:
  `c9a7899d-e71e-429d-af0b-b718d352cda1`
- Operation/refill:
  `a7485225-49de-43e2-9bed-80f264d89e2a`
- Job:
  `ba309995-31c5-4dbe-ae7f-fe13406ee5dc`
- Outbox:
  `56f859ac-2002-4fcb-a02d-087f9a6359c8`
- Temporal workflow:
  `backlinks:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:68299b17-33d6-4993-b106-cf24f1f880bc:recommendation-refill:v1:ba309995-31c5-4dbe-ae7f-fe13406ee5dc`

No second refill was created. Accepted-task recovery retained the same
Provider request/task IDs and did not repeat `task_post`.

The Provider/recovery run used matching Core and Worker build:

- build ID:
  `local-product-c2c451396b83f408cca31419`
- Core and Worker both reported that exact identity before consumption.

After the final GET/inventory projection correction, the read-only acceptance
Core was rebuilt and loaded with:

- build ID:
  `local-product-d6ab83d41a7d61ca13584d57`
- source fingerprint:
  `d6ab83d41a7d61ca13584d570555bbf8f8cb60407ea6ccb172e37d8b9fab720f`
- artifact fingerprint:
  `c6da4ae96ef54226cae6461b765f1b39a8ea163aef43775c0cf967a417ca5e31`
- built at:
  `2026-08-21T13:04:06.081Z`

The old Core PID `15464` was stopped explicitly. One short native
`Start-Process` attempt failed because the required environment was absent; it
was not retried in a loop. Core then started through native PowerShell
`Start-Process -WindowStyle Hidden` with the existing project startup
environment and all paid Provider capabilities disabled. The resulting Core
PID was `22712`, and `/health` returned the exact build above.

### Terra Blueprint And All Queries

- Blueprint ID:
  `12861f9e-d200-409d-8446-c15d5afa9237`
- generator: `AI`
- provider/model: `openai / gpt-5.6-terra`
- model version: `2026-08-03`
- schema version: `commercial-discovery-blueprint.v5`
- prompt version: `commercial-discovery-blueprint-prompt.v5`
- rule version: `commercial-discovery-blueprint-rules.v5`
- generated at: `2026-08-21T04:22:30.691Z`
- AI calls: `1`
- AI cost: `USD 0.000863`

Persisted planner input summary:

- fingerprint:
  `b633d960...`
- language: `en`
- country: `ZA`
- countries: `1`
- keywords: `5`
- products: `2`
- languages: `1`
- semantic seeds: `4`
- target audiences: `1`
- partnership goals: `1`
- promotion targets: `1`
- explicit competitors: `0`

Each query ID is the production-contract value
`SHA-256(blueprintId + NUL + query)`.

| # | Query ID | Terra query | Executed |
|---:|---|---|---|
| 1 | `6ab6496c85b0ed689bef3ec5de29e27ecb2b28fc25a39018dfc56f6578e0326d` | South Africa streaming service review sites | No |
| 2 | `a97d8647350c8c26b3176b4feebdacbd8975ba30561e26fe26b794e7427d6a02` | South Africa streaming service entertainment publications | No |
| 3 | `fdfe37e6553cae03796f4cfa676957835dacc681510974e1840e6918d48dddac` | South Africa TV streaming technology blogs | No |
| 4 | `5391de312a72800d61fbc2858aed34d36671afc722497c460f09d01445fb7a66` | South Africa film and TV review publications | No |
| 5 | `c999eb7f3cb0a5c6b0bb78fcd4128387a5c543fb73cfcc35e0075e43c9a1fbc2` | South Africa streaming app review websites | No |
| 6 | `53ac66e5c460f06af3249609d0d9ecc23de106132b81f6b582d59459fa652f61` | Cape Town streaming entertainment guides | No |
| 7 | `bdb65f7f2ced3ce50cfc8cfe32d8989de9c47a18f2d5f37bcf2e4e4ddc8df98c` | South Africa digital entertainment industry publications | Yes |
| 8 | `a7564414aa3f736e0d746a54d4b3ce5a27d97991188bc6e30b963aa8642ddb99` | South Africa home entertainment resource sites | Yes |
| 9 | `3abdff386ccb696c7d3ddea37a8e29fbdcb0a08c153aac8bdc402c6d245654f0` | South Africa television and streaming guides | Yes |
| 10 | `d41da0306e52a211599e8257c318b33bf68754f2f32b70afd8ac0a528b2ae1f9` | South Africa local streaming service comparisons | Yes |

The Blueprint was persisted before Provider request creation. Every executed
semantic request and normalized artifact stored its matching
`blueprintId/queryId`. The lineage was excluded from the external DataForSEO
payload.

### DataForSEO Semantic Calls

All four calls used
`/v3/serp/google/organic/task_post`, language `en`, location `2710`, and cost
`600` micros each.

| Query/source bucket | Request ID | Provider task ID | Returned | Persisted | Cost |
|---|---|---|---:|---:|---:|
| digital entertainment publications / `bdb65f...df98c` | `88729ffd-faee-42c6-ab6d-69f014246bc6` | `08210709-1594-0066-0000-81c2e966100b` | 9 | 7 | USD 0.000600 |
| home entertainment resources / `a75644...ddb99` | `491d54b5-153e-4e41-84f3-7fd3ec37d0b7` | `08210845-1594-0066-0000-898c2bbab3be` | 9 | 8 | USD 0.000600 |
| television and streaming guides / `3abdff...654f0` | `3d962a30-5294-42d5-b884-ffbd56fd46ef` | `08210847-1594-0066-0000-d17d6a0f8a08` | 8 | 6 | USD 0.000600 |
| local streaming comparisons / `d41da0...ae1f9` | `b2ddfebf-8b25-47fb-b8b9-cf36e3bc3e66` | `08210847-1594-0066-0000-fb77a5f72509` | 9 | 5 | USD 0.000600 |

Real returned domains by semantic request:

1. Digital entertainment publications:
   `african.business`, `broadmedia.co.za`, `etech-news.co.za`, `f6s.com`,
   `facebook.com`, `globalmediajournal.com`, `nfvf.co.za`, `pwc.co.za`,
   `themediaonline.co.za`.
2. Home entertainment resources:
   `entertainment-online.co.za`, `facebook.com`, `givingmore.co.za`,
   `infobelpro.com`, `pwc.co.za`, `saweddings.co.za`,
   `scarlettentertainment.com`, `soundx.co.za`, `thegigster.com`.
3. Television and streaming guides:
   `apple.com`, `bbcafricachannels.com`, `dstv.com`, `etv.co.za`,
   `google.com`, `mydorpie.com`, `openview.co.za`, `supersport.com`.
4. Local streaming comparisons:
   `facebook.com`, `fibretiger.co.za`, `geekhub.co.za`, `hippo.co.za`,
   `mybroadband.co.za`, `onairtv.co.za`, `reddit.com`,
   `splingmovies.com`, `youtube.com`.

The four normalized artifacts reported `9`, `9`, `8`, and `9` returned
domains. Product filtering and deduplication persisted `25` unique candidates.

### DataForSEO Qualification Calls

Qualification used only the remaining paid allocation after semantic
discovery:

| Stage | Request ID | Provider task ID | Endpoint | Targets | Cost |
|---|---|---|---|---:|---:|
| traffic | `c3e7b967-8b3f-4a2e-a2af-c0bcca395499` | `08210848-1594-0391-0000-56e06aa06da4` | `/v3/dataforseo_labs/google/bulk_traffic_estimation/live` | 15 | USD 0.013800 |
| spam | `782c74cd-20cc-43f4-9cc4-ad6c1317cfd4` | `08210848-1594-0482-0000-3a673701a896` | `/v3/backlinks/bulk_spam_score/live` | 15 | USD 0.024540 |
| rank | `41f614e2-1414-410d-b219-fbe5ae333097` | `08210848-1594-0347-0000-3a9c51c4e3a0` | `/v3/backlinks/bulk_ranks/live` | 15 | USD 0.024540 |

Qualification targets:

`african.business`, `dstv.com`, `entertainment-online.co.za`,
`etech-news.co.za`, `etv.co.za`, `fibretiger.co.za`, `geekhub.co.za`,
`infobelpro.com`, `nfvf.co.za`, `onairtv.co.za`, `saweddings.co.za`,
`scarlettentertainment.com`, `soundx.co.za`, `splingmovies.com`, and
`thegigster.com`.

The current job therefore made exactly `7` paid DataForSEO calls: `4`
semantic and `3` qualification. It did not make seven semantic calls.

### All 25 Persisted Candidates

`complete` means the current V4 qualification fact was complete.
`partial` means the score used allowed partial evidence. Contact absence is not
a hard exclusion; visible qualified rows are `CONTACT_PENDING`.

| Domain | Source query ID | V4 | Evidence | Qualification/contact state | Result and reason |
|---|---|---:|---|---|---|
| `saweddings.co.za` | `a75644...ddb99` | 57.2861 | complete | eligible / `CONTACT_PENDING` | Visible; no malicious, PBN, mega-brand, or cooperation hard gate |
| `splingmovies.com` | `d41da0...ae1f9` | 53.4741 | complete | eligible / `CONTACT_PENDING` | Visible; independent film/editorial site, no hard gate |
| `scarlettentertainment.com` | `a75644...ddb99` | 53.3192 | complete | eligible / candidate_ready | No hard gate; not published in this window, retained as residual projection risk |
| `infobelpro.com` | `a75644...ddb99` | 53.0316 | complete | eligible / `CONTACT_PENDING` | Visible; not used as the sole cooperation-quality proof |
| `african.business` | `bdb65f...df98c` | 52.2446 | complete | eligible / `CONTACT_PENDING` | Visible; publication, no explicit mega-brand or hard gate |
| `entertainment-online.co.za` | `a75644...ddb99` | 52.1268 | complete | eligible / `CONTACT_PENDING` | Visible; entertainment editorial site, no hard gate |
| `etv.co.za` | `3abdff...654f0` | 50.0509 | partial | insufficient_data / none | Missing current `mega_platform_without_placement_evidence` gate fact; missing fact was not treated as pass |
| `nfvf.co.za` | `bdb65f...df98c` | 50.0028 | complete | eligible / `CONTACT_PENDING` | Visible; industry resource body, no hard gate |
| `dstv.com` | `3abdff...654f0` | 49.9921 | complete | excluded / none | Below unchanged V4 threshold 50 |
| `thegigster.com` | `a75644...ddb99` | 46.1419 | complete | excluded / none | Below threshold |
| `geekhub.co.za` | `d41da0...ae1f9` | 43.2974 | complete | excluded / none | Below threshold |
| `onairtv.co.za` | `d41da0...ae1f9` | 43.2028 | complete | excluded / none | Below threshold |
| `etech-news.co.za` | `bdb65f...df98c` | 42.9864 | complete | excluded / none | Below threshold |
| `soundx.co.za` | `a75644...ddb99` | 40.9094 | complete | excluded / none | Below threshold |
| `fibretiger.co.za` | `d41da0...ae1f9` | 40.8798 | complete | excluded / none | Below threshold |
| `mydorpie.com` | `3abdff...654f0` | 36.6071 | partial | excluded / none | Hard exclusion: zero topic relevance |
| `supersport.com` | `3abdff...654f0` | 33.9307 | partial | excluded / none | Below threshold |
| `broadmedia.co.za` | `bdb65f...df98c` | 32.8571 | partial | excluded / none | Hard exclusion: zero topic relevance |
| `bbcafricachannels.com` | `3abdff...654f0` | n/a | incomplete | insufficient_data / none | Missing gate, semantic, placement, market, and traffic evidence |
| `f6s.com` | `bdb65f...df98c` | n/a | incomplete | insufficient_data / none | Missing gate, semantic, placement, market, and traffic evidence |
| `givingmore.co.za` | `a75644...ddb99` | n/a | incomplete | insufficient_data / none | Missing gate, semantic, placement, market, and traffic evidence |
| `globalmediajournal.com` | `bdb65f...df98c` | n/a | incomplete | insufficient_data / none | Missing gate, semantic, placement, market, and traffic evidence |
| `mybroadband.co.za` | `d41da0...ae1f9` | n/a | incomplete | insufficient_data / none | Missing gate, semantic, placement, market, and traffic evidence |
| `openview.co.za` | `3abdff...654f0` | n/a | incomplete | insufficient_data / none | Missing gate, semantic, placement, market, and traffic evidence |
| `pwc.co.za` | `bdb65f...df98c`, `a75644...ddb99` | n/a | incomplete | insufficient_data / none | Missing gate, semantic, placement, market, and traffic evidence |

All current static assessments used for admission reported
`malicious=false` and `pbn=false`; the two explicit zero-topic rows remained
hard excluded. Amazon and GitHub were absent from all 25 persisted current
candidates. The V4 threshold remained `50`.

### Publication, GET, And UI

The recovered job terminated:

- status: `success`
- step: `target_reached`
- progress: `100`
- outcome: `TARGET_REACHED`
- added count: `8`
- evaluated: `9`
- ready: `8`
- insufficient data: `1`
- excluded in that publication pass: `0`
- terminal reason: `EXISTING_EVIDENCE_WINDOW_COMPLETED`
- outbox status: `published`
- outbox attempt: `7`

The formal recommendation GET returned exactly these eight current cards:

| Domain | V4 | Source/lineage | Qualification/contact |
|---|---:|---|---|
| `saweddings.co.za` | 57.2861 | Terra home resources / `a75644...ddb99` | eligible / `CONTACT_PENDING` |
| `marketsandmarkets.com` | 54.6701 | historical query `streaming service in sa ZA adjacent industry publication` | eligible / `CONTACT_PENDING` |
| `sajim.co.za` | 54.4975 | historical query `streaming service in sa ZA adjacent industry publication` | eligible / `CONTACT_PENDING` |
| `splingmovies.com` | 53.4741 | Terra local comparisons / `d41da0...ae1f9` | eligible / `CONTACT_PENDING` |
| `infobelpro.com` | 53.0316 | Terra home resources / `a75644...ddb99` | eligible / `CONTACT_PENDING` |
| `african.business` | 52.2446 | Terra digital publications / `bdb65f...df98c` | eligible / `CONTACT_PENDING` |
| `entertainment-online.co.za` | 52.1268 | Terra home resources / `a75644...ddb99` | eligible / `CONTACT_PENDING` |
| `nfvf.co.za` | 50.0028 | Terra digital publications / `bdb65f...df98c` | eligible / `CONTACT_PENDING` |

GET returned `presentationState=current`. The UI refresh showed
`已验证匹配 8/10` and the same eight domains, scores, and
`联系人处理中` states. No extra or missing card existed between GET and UI.

Read-only UI evidence:

- screenshot:
  `output/playwright/stage2q-elephtv-real-provider-verified.png`
- SHA-256:
  `C729C6097B194A499E6A04F47C149FBEC4DD5ECB137C81946C33A78EB2BE4CFA`
- captured application URL:
  `/projects/68299b17-33d6-4993-b106-cf24f1f880bc/backlinks/recommendations`

No click on the UI continuation command was made.

### Provider Ledger And Cost

Current job authoritative Provider usage:

- semantic calls: `4`
- qualification calls: `3`
- total calls: `7`
- semantic cost: `2400` micros (`USD 0.002400`)
- qualification cost: `62880` micros (`USD 0.062880`)
- total DataForSEO cost: `65280` micros (`USD 0.065280`)
- Terra planning cost: `USD 0.000863`
- combined current planning and DataForSEO cost: `USD 0.066143`

Terminal cumulative Provider ledger:

- succeeded requests: `53`
- failed requests: `12`, all with zero cost
- settled usage rows: `53`
- cumulative settled cost: `897348` micros (`USD 0.897348`)
- reserved rows: `0`
- unknown-charge rows: `0`
- active leases: `0`

The ledger, not the inventory projection, is the cost source of truth.
Repeated GET/UI reads caused no new Provider request or charge.

### Generic Product Corrections And Verification

The durable path includes:

- semantic stage reservation and priority before paid qualification;
- persisted Terra Blueprint/query lineage across request, normalized artifact,
  accepted-task recovery, and retry;
- explicit DataForSEO accepted-task pending parsing with bounded same-task
  polling and no second `task_post`;
- budget replenishment through formal authorization/product paths;
- existing-evidence continue-as-new execution-window guards;
- immutable, append-only V4 qualification facts with stable same-conclusion
  fact IDs and new attempts for changed conclusions;
- guarded, idempotent recovery of the exact
  `partial_success/existing_evidence_no_progress` state;
- corrected publication visibility for both `PUBLISHED` and
  `CONTACT_PENDING`; and
- recommendation inventory summary counting `CONTACT_PENDING` as visible.

Focused verification completed:

- accepted-task pending, timeout, malformed, lineage, and no-second-post tests:
  passed;
- semantic reservation/budget/recovery regression tests: passed;
- continue-as-new old-history/new-history/no-repeat-Provider tests: passed;
- immutable qualification fact and publication guard tests: passed;
- `recommendations-route.test.ts`: `13/13` passed;
- `stage2q-recommendation-contract.test.ts`: `6/6` passed;
- TypeScript typecheck: passed;
- production build: passed.

The focused implementation touched the generic recommendation modules,
including:

- `commercial-official-runtime.ts`
- `commercial-discovery-source.ts`
- `commercial-recommendation-discovery.service.ts`
- `commercial-inventory-refill.service.ts`
- `provider-operation-budget.ts`
- `backlink-recommendation-refill.workflow.ts`
- `backlink-recommendation-refill.orchestration.ts`
- `recovery.ts`
- `recommendations.command.ts`
- `commercial-qualification.service.ts`
- `commercial-qualification-production.service.ts`
- `recommendation-contract.repository.ts`
- `local-product-dataforseo-runtime.ts`
- `recommendations.query.ts`

The workspace was already heavily dirty. Existing unrelated modifications were
preserved. Nothing was cleaned, reverted, committed, or pushed.

### Side Effects And Terminal Runtime

No Opportunity, Gmail message, Placement, or Indexification action was
created. No candidate, score, fact, job, outbox, operation, or ledger business
state was written by manual SQL.

After acceptance:

- Worker PID `5276` was stopped explicitly;
- Worker port `7302` had no listener;
- `business_consumers_running=false`;
- DataForSEO, Browser, AI, and Gmail capabilities were disabled;
- Core remained running on build
  `local-product-d6ab83d41a7d61ca13584d57`;
- effective terminal state is maintenance/quiesced with Provider execution
  unavailable.

No Provider request was made after the Worker stopped.

### Remaining Risks

These discrepancies did not prevent the required real-provider and GET/UI
acceptance, but remain explicit follow-up risks:

1. `scarlettentertainment.com` has a complete eligible V4 fact at `53.3192`
   with no hard gate, but remained `candidate_ready` rather than visible.
2. Inventory reported `rawCandidateCount=0` although 25 current-batch
   candidates were persisted.
3. Inventory projected `providerActualCostMicros=78732` and
   `providerPaidCallCount=3`, while the authoritative current-job ledger
   recorded `65280` micros and `7` calls.
4. The UI product state remained `running/READY_TO_CONTINUE` because eight
   visible matches are below the configured target of ten, while the recovered
   job itself ended `success/EXISTING_EVIDENCE_WINDOW_COMPLETED`. No
   continuation was triggered.
5. The formal recovery HTTP surface returned `500` after the transactional
   rearm had committed; the existing outbox was nevertheless consumed once
   and completed. This response/commit mismatch requires separate hardening
   before it is relied on as a clean operator response.

These risks were not hidden by lowering the V4 threshold, relaxing hard
exclusions, fabricating candidates, manually changing database state, or
starting another refill.
