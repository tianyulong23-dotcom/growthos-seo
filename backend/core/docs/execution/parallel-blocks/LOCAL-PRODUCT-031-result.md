# LOCAL-PRODUCT-031 以可发布推荐为目标的持续补货结果

- 执行日期：`2026-08-10`（星期一）
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-031`
- 最终状态：`PASS`
- Stop boundary：未执行 `LOCAL-PRODUCT-032..033`

## 1. 结论

Recommendation Refill 现在以当前 Website Project 中真正可发布的网站数量判断
Low/High Watermark，不再使用原始 Candidate 数量或尚未完成联系人验证的数量。

一条可计入水位的推荐必须同时满足：

```text
publication_status=PUBLISHED
fit_decision=eligible
fit_score_model_version=recommendation-commercial-fit.v3
contact_decision=eligible
contact_reason_code=PUBLIC_EMAIL_FOUND
verified_public_email_count>=1
Inventory 和 Recommendation 均为 ready/shown
当前项目同域名尚未加入 Opportunity
```

被拒绝、抑制、重复域名、适合度不合格、没有合格公开联系人或未发布的网站不会
计入可发布水位。

本轮复用现有 Recommendation Refill、Contact Batch、Temporal、Worker、
PostgreSQL 库存和 DataForSEO Provider，没有创建第二套 Provider、Queue、
Worker、Workflow、Crawler、Browser Launcher 或业务状态机。

## 2. 持续补货闭环

### 2.1 五级补货

数量低于 High Watermark 时，现有补货流程按以下固定顺序推进：

1. `exact_product_target_market`：精确产品与目标市场；
2. `same_topic_target_market`：同主题与目标市场；
3. `adjacent_industry_same_audience`：相邻行业与相同受众；
4. `resource_media_review_partner_ecosystem`：资源、媒体、评测与合作伙伴生态；
5. `same_language_expansion`：相同语言扩展市场。

每一级仍复用 `recommendation-commercial-fit.v3` 的最低主题相关性、质量风险、
市场和联系人发布门槛。层级扩大只改变发现查询，不降低发布标准。

只有当前发现批次完成、现有 Contact Batch 无非终态 Job，并形成最终可发布数量
之后，流程才会判断 High Watermark 或进入下一层。

### 2.2 幂等与恢复

每轮使用确定性键：

```text
commercial-refill:
  {websiteProjectId}:{projectContextVersionId}:t{tier}:r{round}
```

该键同时进入现有 Recommendation Refill 命令、Job、Provider Request 和预算
预留边界。页面刷新、API 重新读取、项目切换和 Worker Restart 不会生成新的轮次
键；成功批次不会被重新打开。

Provider 调用前失败时只允许复用同一个 Job，并先检查 Provider Usage Ledger 和
Provider Batch Request。已经产生 Provider 副作用的 Job 不会作为无成本重试再次
调用 Provider。

未完成状态保存在现有 Inventory Policy 和 Commercial Discovery Batch 中。
Worker Restart 后从当前项目、Context、层级和轮次恢复，不使用跨项目缓存。

### 2.3 明确终止

补货流程保存并返回以下终止原因：

- `HIGH_WATERMARK`
- `BUDGET`
- `PROVIDER_UNAVAILABLE`
- `TIERS_EXHAUSTED`
- `PROJECT_CONTEXT`

数量不足时 API 同时返回真实 `rawCandidateCount`、
`publishedContactReadyCount`、`attemptedRefillTiers` 和
`eliminationReasonCounts`，不会返回伪造补足或空成功。

## 3. Contact Batch 终态收口

运行态复验发现一个历史 Contact Batch 的 62 个 Job 已全部终态，但批次仍保留
`running`，且部分 0054 前库存投影仍为 `contact_decision=pending`。

031 在现有补货扫描入口增加了幂等收口：

- 只处理当前组织、Workspace、Website Project 和 Context；
- 批次必须为 `running`；
- 批次必须至少存在一个 Job；
- 不存在 `pending`、`running` 或 `retry_scheduled` Job 时才标记为
  `completed`；
- 已有终态 Job 不会因旧库存投影继续被视为处理中；
- 新建或真正运行中的 Contact Job 仍会阻止层级前进。

该修复只修正现有 Contact Batch 的终态投影，没有新增队列、Worker 或工作流。

## 4. 数据库、API 与前端

迁移 `0055_backlink_publishable_refill_cycle.sql` 在现有表中保存：

- refill state；
- current tier 和 round；
- attempted tiers；
- termination reason；
- raw/publishable count；
- elimination reason counts。

迁移没有新增 Provider、Queue、Worker 或 Workflow 表。部署清单、PostgreSQL 18
校验、启动脚本和状态脚本均已更新到 `0055`。

Backlinks OpenAPI、共享 Platform OpenAPI、FastAPI Gateway 和 frontend
generated client 已同步新增字段。

前端 Recommendation Workspace 会显示：

- 原始候选数与真实可发布数；
- 当前层级与轮次；
- 已尝试层级；
- 淘汰原因；
- High Watermark、预算、Provider 不可用和层级耗尽的说明。

终态不会继续显示等待按钮；用户仍可刷新读取真实状态。

## 5. 验收映射

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 68 个原始候选、24 个可发布时按 24 判断 | PASS | `commercial-inventory.test.ts` 明确使用 `candidateReadyCount=68`、`publishedContactReadyCount=24`，结果继续补货 |
| 低于 High Watermark 自动继续发现与联系人处理 | PASS | active refill cycle 忽略旧 cooldown；发现完成且 Contact Batch 终态后进入下一层 |
| 刷新、重读、项目切换不新增 Provider Ledger | PASS | 项目/Context/层级/轮次确定性键；运行态前后 Provider Request 和 Usage Ledger 均未增长 |
| 不同项目独立补货 | PASS | 所有状态、计数、Contact Batch、Job、Provider Ledger 和幂等键均包含 Website Project；无共享候选或层级进度 |
| 无法补足时前端解释原因而非无限等待 | PASS | 历史陈旧批次被收口为 `completed`；API 返回 `refillState=paused`、`terminationReason=BUDGET` |

## 6. 验证

### 6.1 Backlinks Core

```text
Vitest targeted: 7 files passed, 44 tests passed
npm run typecheck: PASS
targeted ESLint: PASS
npm run build: PASS
npm run migration:backlinks:check: PASS, 48 files through 0055
npm run openapi:backlinks:check: PASS, 70 paths
git diff --check: PASS
```

测试覆盖 68/24 水位判断、活动补货直到 High、五层推进和耗尽、预算/Provider
终止、项目/Context/层级/轮次幂等键、Contact Batch 终态等待、陈旧批次安全收口、
Provider 前失败恢复和 Recommendation API 合同。

### 6.2 FastAPI 与共享合同

```text
pytest database migration system: 5 passed
pytest shared contracts + migration system: 9 passed
shared contract check: PASS, 90 public paths / 96 operations
```

### 6.3 Frontend

```text
Backlinks generated client: PASS, 71 operations
npm run check:backlinks-client: PASS, 71 operations
npm run typecheck: PASS
npm run build: PASS
recommendations source tests: 2 passed
```

未执行 `LOCAL-PRODUCT-033` 才允许执行的全量 Backlinks Gate。

## 7. 运行态证据

`2026-08-10 13:08:52 +08:00` 最终状态：

```text
status=ok
runtimeMode=LOCAL_PRODUCT
runId=20260810-130717
projectKey=elephtv
Frontend HTTP=200
FastAPI HTTP=200
Private Core HTTP=200
PostgreSQL 18=healthy
Backlinks migration head=0055
Temporal=healthy
Temporal namespace ready=true
Core API running=true
Worker running=true
```

Gateway Recommendation Inventory 返回 `HTTP 200`：

```text
rawCandidateCount=0
publishedContactReadyCount=0
refillInFlight=false
refillState=paused
currentRefillTier=exact_product_target_market
currentRefillRound=1
attemptedRefillTiers=[]
terminationReason=BUDGET
contactBatch.status=completed
contactBatch.totalJobCount=62
contactBatch.terminalJobCount=62
contactBatch.publishedCount=0
contactBatch.unpublishedCount=62
```

当前真实预算剩余 `25,948 micros`，低于单次估算
`27,600 micros`，因此系统在 Provider 调用前以 `BUDGET` 终止。没有伪造候选、
邮箱、可发布推荐或已尝试层级。

## 8. Provider 安全

迁移、构建、Restart、Worker 扫描和 API 读取前后：

```text
Provider Request count=87
latest Provider Request=2026-08-10 01:10:27.160676 UTC
Provider Usage Ledger count=84
latest Usage Ledger=2026-08-10 01:10:27.185072 UTC
DATAFORSEO_MAX_PAID_CALLS=250
DataForSEO budget limit=1,000,000 micros
spent=974,052 micros
reserved=0
remaining=25,948 micros
```

请求数量、Ledger 数量和最新时间均未变化。本轮没有发起真实 DataForSEO 或 AI
调用，没有修改预算上限、Kill Switch、历史 Ledger 或 Gmail 人工确认边界。

## 9. 停止

`LOCAL-PRODUCT-031` 已完成并写入本 Result。未执行
`LOCAL-PRODUCT-032..033`，未重写 `LOCAL-PRODUCT-000..030`，未 commit，
未 push。当前分支仍为 `外链part`，HEAD 仍为
`d796989207cd7dfdec4c0a3fdbc46f855bf0fff9`。
