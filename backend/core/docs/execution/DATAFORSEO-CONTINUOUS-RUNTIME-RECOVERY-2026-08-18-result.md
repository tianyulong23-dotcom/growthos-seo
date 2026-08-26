# DATAFORSEO-CONTINUOUS-RUNTIME-RECOVERY-2026-08-18

## Start Card

- Authority: user lifted the historical prohibition on new DataForSEO `task_post` calls on 2026-08-18.
- Scope: restore governed continuous DataForSEO operation by renewing bounded budget cycles and allowing settled budget-paused refill windows to advance.
- Provider ceiling: 25 candidate domains, at most 3 paid calls per project per UTC day, at most 1,000,000 micros per workspace per UTC day.
- Preserved controls: endpoint allowlist, Kill Switch, idempotency, provider usage ledger, unknown-charge handling, and per-call reservation.
- Forbidden: unbounded spend, manual database mutation, unrelated Phase work, Gmail/AI/SafeFetch calls, commit, or push.
- Stop point: focused tests, typecheck/build, loaded Worker, and one bounded runtime acceptance with provider/ledger evidence.

## Result

Status: COMPLETE

### Product behavior

- New DataForSEO `task_post` calls are enabled again. The historical single-task reuse restriction is no longer part of the runtime path.
- A workspace receives one governed DataForSEO budget cycle per UTC day.
- Each project can make at most 3 paid calls in that daily cycle.
- Each workspace can spend at most 1,000,000 micros ($1.00) in that daily cycle.
- Retry attempts reuse the existing reservation/idempotency record instead of purchasing a duplicate request.
- A refill that has exhausted the daily paid-call ceiling remains `paused_budget` without being requeued every minute. A later daily cycle can advance the same product workflow.
- Endpoint allowlisting, Kill Switch checks, usage-ledger settlement, unknown-charge handling, and provider request fingerprints remain enforced.

### Focused verification

- Focused unit tests: 38 passed across:
  - `test/unit/commercial-inventory-refill.test.ts`
  - `test/unit/production-runtime.test.ts`
  - `test/unit/local-product-dataforseo-runtime.test.ts`
- PostgreSQL integration tests: 9 passed in `test/backlinks/integration/dataforseo-cost-control-migration.test.ts`.
- `npm run typecheck`: passed.
- ESLint on the touched implementation and test files: passed.
- `npm run build`: passed.
- `git diff --check` on the scoped implementation: passed with line-ending warnings only.

### Loaded build

- Build ID: `local-product-11a6ee0d5c2c3db41a86c088`
- Source fingerprint: `11a6ee0d5c2c3db41a86c088db2b5419554e4c39e2cc98dfdfc3deb40208b298`
- Artifact fingerprint: `246132c660dd148a58ada3887b9e905baf50eeba1d03d37cceea91fe036acc70`
- Built at: `2026-08-18T02:17:10.612Z`
- Worker PID: `28548`
- Worker health: `http://127.0.0.1:7302/health` returned `status=ok`, the expected build ID, and `businessConsumersRunning=true`.
- A 70-second post-start observation showed no additional `refill.queued`, `ExpectedVersion`, or error log entry. The policy version, refill-job version, provider task count, and provider cost remained unchanged.
- The managed-process registry was restored at `storage/runtime/m1c/seo-main-ui/processes.json`; all four registered processes match their current PID, executable name, and expected command.

### Real-provider acceptance

- Historical provider task retained:
  - `08170750-1594-0066-0000-3238aea9b1e4`
- New governed provider tasks:
  - `08180212-1594-0066-0000-623afe678f7f`
  - `08180212-1594-0066-0000-30c799eb1219`
  - `08180213-1594-0066-0000-5c38001d08e9`
- Endpoint for all four tasks: `/v3/serp/google/organic/task_post`.
- New paid calls on 2026-08-18: 3.
- New actual cost: 1,800 micros ($0.0018).
- Lifetime actual cost represented by these four provider tasks: 2,400 micros ($0.0024).
- Usage ledger: 4 settled, 0 reserved.
- `unknown_charge`: 0.
- Current daily budget:
  - ID: `550464e4-2a9c-4274-bb39-d5801519da17`
  - Period: `2026-08-18T00:00:00Z` to `2026-08-19T00:00:00Z`
  - Limit: 1,000,000 micros
  - Spent: 1,800 micros
  - Reserved: 0
- The accepted refill job `5487ca37-4cbb-403d-ab0b-de7065acd9c9` ended as `partial_success / paused_budget` after exactly 3 paid calls. Its discovery batch contains 16 raw candidates and 1 eligible candidate.
- The canonical historical job `f6955fdf-4ba0-41db-a31a-566c7292603a` remains `partial_success / paused_budget`.
- Duplicate job `c1a502b5-826f-4759-9573-d99b7ae9ba48` remains `cancelled / duplicate_closed`.

### Known startup blocker

The current Worker is running and DataForSEO task creation is operational. However, a future clean full-stack startup through `scripts/dev-up.ps1` is still blocked by the unrelated, untracked migration `0068_backlink_cooperation_path_opportunities.sql`:

`there is no unique constraint matching given keys for referenced table "backlink_recommendation_cooperation_path_facts"`

The failed migration transaction rolled back. No database row was manually edited. Fixing that migration belongs to a separate authorized scope; until then, a full stop or machine restart requires resolving this startup blocker before the standard launcher can recover the complete stack.
