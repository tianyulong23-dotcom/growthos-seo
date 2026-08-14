# LOCAL-PRODUCT-020 Backlink Profile 与库存闭环

- 执行日期：`2026-08-06`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-020`
- 最终状态：`PASS_CODE_PROVIDER_INPUT_REQUIRED`
- Branch：`外链part`
- Baseline HEAD：`d796989207cd7dfdec4c0a3fdbc46f855bf0fff9`
- Stop boundary：未执行 `LOCAL-PRODUCT-021`

## 1. 结论

Backlink Profile 的服务端数据模型、PostgreSQL migration、Temporal durable sync、DataForSEO
official adapter、预算与调用治理、FastAPI Gateway、OpenAPI/generated client 和 Links Profile 页面已经
完成。实现继续保持 Core 为生命周期权威、PostgreSQL 为业务事实、Temporal 为耐久任务，不创建第二套
队列或 Provider 事实源。

ElephTV 的真实本地同步请求已经进入 `waiting_provider`，未伪造快照、健康分、库存或供应商成功结果。
当前 DataForSEO 开关为关闭，单次 Profile 同步预计需要 `55,200 micros`，而预算仅剩
`17,200 micros`，因此系统拒绝调用并保持 `actualCostMicros=0`。按任务规则，本轮状态为
`PASS_CODE_PROVIDER_INPUT_REQUIRED`。

## 2. Profile 数据与同步模型

新增 migration：

```text
0050_backlink_profile_inventory.sql
```

Migration checksum：

```text
26a61271db939c61cf95ee2e42096fe2347c1293a35de97c60d4bab7535814c3
```

新增并纳入 RLS/租户边界的核心事实包括：

- `ProfileSyncJob`：Full/Incremental、触发来源、Provider、费用、覆盖率和幂等状态；
- `ProfileSnapshot`：项目 canonical domain 的时间点汇总事实；
- `BacklinkInventoryItem`：规范化 source URL、target URL、Provider identity 去重库存；
- `BacklinkObservation`：append-only 的首次、最近和状态观察；
- `ProfileHealthSnapshot`：确定性健康分及 `insufficient_data` 状态；
- `ProviderArtifact`：请求意图、endpoint、fingerprint、task/page identity、原始证据与费用；
- `ProfileSyncCursor`：项目级增量游标、freshness 和下次同步时间。

Provider 可用时，Profile 支持 summary、referring domains、backlinks inventory、new/lost、anchor、rel、
country、TLD、rank/spam、target 等供应商实际返回字段；Provider 不返回的字段保持 unavailable，不用
推断值填充。用户导入复用同一库存，来源标记为 `USER_IMPORTED`。

Observation 可引用已有 Placement/Opportunity，但发现外链不会自动创建 Placement，也不会改变
Opportunity 生命周期。Pinned/Managed 只保留模型和页面标识，未实现 021 的高频直接验证动作。

## 3. 健康分、覆盖率与调度

健康分由九个确定性分量组成：

1. Referring domain diversity
2. Authority quality
3. Toxicity/spam risk
4. Follow mix
5. Anchor concentration
6. Country relevance
7. TLD diversity
8. New/lost momentum
9. Target distribution

当库存覆盖不足或 Provider 数据不可用时，健康状态为 `insufficient_data`，不会输出伪精确评分。
`totalCount`、`pulledCount` 和 `inventoryCoverage` 分开记录，分页库存不会被误报为完整总量。

连续调度只处理已经存在且到期的 Profile cursor，按项目公平选择；不会因为一个项目暂停而阻塞其他
项目，也不会在无用户意图时突然发起 Full Sync。Provider 关闭时保留最近快照并标记 stale/unavailable。
每个 endpoint 请求都必须经过 allowlist、kill switch、max paid calls、预算 reservation、ledger settle
和缓存/freshness 门禁；未发出的第二个请求会释放 reservation。

## 4. Links Profile 页面

`/projects/{websiteProjectKey}/backlinks/links` 已接入真实 Profile API，包含：

- 总 backlinks、referring domains、new/lost 和库存覆盖率；
- 健康状态及九分量；
- anchor、rel、country、TLD、rank/spam 和 target 分布；
- 可筛选、排序、分页的库存；
- source、target、first seen、last seen、latest provider/direct validation；
- 最近同步、下次同步、预计/实际费用、partial/stale/provider-required 状态；
- Provider 不可用时的明确空态和同步提示。

页面不使用 mock fallback 代替服务端 Profile 事实。Desktop、390px Mobile、键盘导航和 serious a11y
门禁均通过。

## 5. 真实本地验收

ElephTV Profile：

```text
canonicalDomain: elephtv.com
snapshot: null
health: null
providerEnabled: false
status: waiting_provider
providerInputRequired: true
estimatedCostMicros: 55200
actualCostMicros: 0
```

ElephTV Inventory：

```text
items: []
page: 1
pageSize: 20
totalCount: 0
totalPages: 0
```

同步 Job：

```text
jobId: 9d0f0851-d507-41d4-84cc-17ef645d2e36
status: waiting_provider
totalCount: null
pulledCount: 0
inventoryCoverage: null
estimatedCostMicros: 55200
actualCostMicros: 0
providerArtifacts: 0
```

使用相同 Idempotency-Key 重放后返回同一 `jobId` 且 `replayed=true`。数据库预算仍为
`spentMicros=82,800`、`reservedMicros=0`，没有发生 Provider 调用或新增费用。

## 6. 验证证据

| 验证 | 结果 |
| --- | --- |
| 020 Profile/adapter/migration/process targeted pack | `6` files, `24/24` |
| Core unit | `99` files, `523/523` |
| Core API | `30` files, `102/102` |
| Core contract | `27` files, `171/171` |
| Core security / resilience | `106/106` / `8/8` |
| Core typecheck | PASS |
| FastAPI gateway/shared contracts | `23/23` |
| FastAPI Ruff | PASS |
| Backlinks migration manifest | `43` files through `0050` |
| Backlinks OpenAPI baseline | `65` paths / `66` operations |
| Aggregate shared contract | `85` paths / `91` operations |
| Source manifest | `28` entries |
| Dependency allowlist / license gate | PASS / `693` packages |
| Backlinks generated client | `66` operations |
| Platform generated client | `6` operations |
| Frontend typecheck / lint / build | PASS |
| Frontend Links source tests | `6/6` |
| Desktop Playwright | `5/5` |
| Mobile 390px Playwright | `1/1`, no page overflow |
| Keyboard + serious a11y | `1/1` |
| `git diff --check` | PASS |

`npm run verify:backlinks` 的聚合 ESLint 仍命中 013 商业推荐模块的 `9` 个既有问题；020 涉及文件和全部
020 定向门禁通过，本轮未越界修改这些模块。全量 Testcontainers integration 聚合在约 124 秒超时，
020 migration 定向测试和真实 PostgreSQL migration 均通过。

## 7. 最终运行状态

| 组件 | 结果 |
| --- | --- |
| Frontend `http://localhost:5173` | HTTP 200 |
| Links Profile `http://localhost:5173/projects/elephtv/backlinks/links` | HTTP 200 |
| FastAPI `http://localhost:7200` | HTTP 200 |
| Profile / Inventory API | HTTP 200 / HTTP 200 |
| Private Core `http://127.0.0.1:7301` | HTTP 200 |
| PostgreSQL 18 | healthy |
| Backlinks head | `0050` |
| Temporal | healthy / namespace ready |
| DataForSEO | disabled |
| Profile Provider artifacts / actual cost | `0 / 0` |

结果文档和运行日志未写入 Provider credential、API Key、Authorization header 或原始敏感响应。

## 8. 剩余输入与边界

要完成任务中的真实 DataForSEO controlled call，需要同时满足：

1. 明确启用 DataForSEO；
2. 可用预算至少覆盖本次 Profile 的两个受控请求，即 `55,200 micros`；
3. 继续保持 allowlist、kill switch、max paid calls 和 ledger 门禁；
4. 只对 ElephTV canonical domain 执行一次受控 Full Sync。

在这些输入满足前，系统会继续保持 `waiting_provider`，不会绕过预算、输出假数据或用 Common Crawl
冒充完整 DataForSEO Profile。本任务到此停止，未执行 `LOCAL-PRODUCT-021`。
