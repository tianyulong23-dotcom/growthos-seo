# LOCAL-PRODUCT-033 多行业、多项目智能推荐最终 Gate 结果

- 执行日期：`2026-08-10`（星期一）
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-033`
- 最终状态：`PASS_CODE_AI_INPUT_REQUIRED`
- 分支：`外链part`
- 基线 HEAD：`d796989207cd7dfdec4c0a3fdbc46f855bf0fff9`
- Stop boundary：完成后停止，不执行后续编号

## 1. 结论

多行业、多项目智能推荐最终 Gate 已完成。

当前实现没有 Aiper、ElephTV、AWOL 或特定行业的生产代码分支。Blueprint、
竞争对手、关键词、市场、候选、评分、Contact Batch、发布库存、活动 Job 和前端
列表均绑定当前 Website Project 与不可变 Context Version。

当前 Aiper 新 Context 已执行完整的受治理真实 DataForSEO 发现。五个允许补货层级
均已尝试，最终产生：

```text
candidateReadyCount=5
publishedContactReadyCount=1
contactBatch.totalJobCount=6
contactBatch.publishedCount=1
refillState=exhausted
terminationReason=TIERS_EXHAUSTED
```

因此系统没有伪造 High Watermark，也没有无限等待，而是返回明确的合格且可联系
供给不足终态。当前发布的一个网站同时满足项目适合度和合规公开邮箱门槛，其余五个
合格候选保留明确的联系人淘汰原因。

AI Secret Reference 和 AI capability 已配置并启用，但本次真实运行没有得到通过
结构化 Schema 的 AI Blueprint。系统按设计生成项目安全的
`DETERMINISTIC_FALLBACK` Blueprint，`model_version` 为空，且没有阻塞真实
DataForSEO、评分、联系人处理和推荐发布。因此本轮不能声明
`PASS_LOCAL_RECOMMENDATION_READY`，允许状态为
`PASS_CODE_AI_INPUT_REQUIRED`。

## 2. 029..032 实际复核

本轮读取了以下 Result，并以实际代码、测试和运行态重新核对：

- `LOCAL-PRODUCT-029-result.md`：项目级 Blueprint、竞争对手和设置版本隔离；
- `LOCAL-PRODUCT-030-result.md`：`recommendation-commercial-fit.v3`、
  Fit/Contact 双门槛和发布合同；
- `LOCAL-PRODUCT-031-result.md`：按可发布库存而非原始 Candidate 分层补货；
- `LOCAL-PRODUCT-032-result.md`：服务端活动批次、持续轮询、刷新恢复和一次终态展示。

实际代码确认：

- 生产运行时不读取全局 `DATAFORSEO_DISCOVERY_TARGETS_JSON`；
- Blueprint 输入来自当前项目 Context 和版本化项目设置；
- Provider、Job、Batch、Inventory、Contact 和 Recommendation 查询均携带
  Organization、Workspace、Website Project 和 Context 范围；
- Recommendation 只有在用户确认后才创建 Opportunity；
- Gmail 状态与 Opportunity 状态保持分离；
- 未增加第二套 Provider、Queue、Worker、Workflow、Crawler 或业务权威。

## 3. 三类业务隔离

定向测试使用三个不同业务类别：

| 项目/Fixture | 类别 | 项目输入 | 显式竞争对手 |
| --- | --- | --- | --- |
| Aiper | 智能泳池清洁设备 | robotic/cordless pool cleaner、smart pool care | `maytronics.com`、`wybotpool.com` |
| ElephTV | 流媒体/创作者视频 | streaming、creator monetization | `showmax.com` |
| LedgerWise Fixture | 会计 SaaS | accounts payable、financial operations | `bill.com` |

验证结果：

- 三个 Context 生成各自独立的 Blueprint 输入；
- Aiper 不接收 ElephTV 的 `showmax.com`；
- LedgerWise 不接收娱乐、投影仪或泳池设备关键词和竞争对手；
- Fixture 无需生产域名硬编码即可工作；
- 同一 Context 的 Blueprint、Provider Gate 和评分调用保持幂等；
- PostgreSQL 18 RLS/项目隔离 Gate 继续通过。

新增隔离测试位于
`backend/core/test/unit/commercial-discovery-blueprint.test.ts`，并已包含在最终
Unit 全量 `568/568` 中。

## 4. 当前 Aiper Context 与历史审计

当前 Aiper：

```text
websiteProjectId=bb2f985a-c4ba-4517-accb-7fe07dbc1d18
recommendationContextVersionId=3e00af13-61e2-4a0d-9d68-d06cf8fed613
activeBlueprintId=42ac4376-f23e-4fb2-a176-8f3c6c6d4bdc
blueprintVersion=2
generator=DETERMINISTIC_FALLBACK
schemaVersion=commercial-discovery-blueprint.v2
promptVersion=commercial-discovery-blueprint-prompt.v2
ruleVersion=commercial-discovery-blueprint-rules.v2
```

当前 Context 输入包括：

- 受众：住宅泳池用户、泳池维护专业人员、智能泳池护理研究者；
- 合作目标：机器人泳池清洁器评测、泳池维护专家贡献、机器人泳池维护指南合作；
- 关键词：robotic pool cleaner、cordless pool cleaner、automatic pool
  cleaning、pool maintenance automation、smart pool care、robotic pool
  maintenance guide；
- 显式竞争对手：`maytronics.com`、`wybotpool.com`。

历史错误或旧 Context Blueprint 没有删除或覆盖。历史 v1 Blueprint
`33100d65-8ef7-473d-8beb-40275453f8ab` 和中间 v2 Blueprint 均保留为
`stale_context`，不再作为当前默认展示。

## 5. 真实 DataForSEO 发现与分层补货

当前 Aiper Context 的五档真实发现结果：

| 层级 | Batch | 状态 | Raw | Eligible | Paid micros |
| --- | --- | --- | ---: | ---: | ---: |
| `exact_product_target_market` | `035f39c2-dfbe-4367-adeb-10aed89c3913` | completed | 100 | 0 | 87,000 |
| `same_topic_target_market` | `3dac2004-ec34-41ee-a2f3-09e69f49a13d` | completed | 100 | 0 | 85,200 |
| `adjacent_industry_same_audience` | `bc6be4c2-3ca0-4746-94ba-66f0ec0b01a3` | completed | 100 | 0 | 85,200 |
| `resource_media_review_partner_ecosystem` | `b8ebc970-6b8c-49e7-9ac5-fdee9f1ffa8a` | unavailable | 100 | 0 | 79,200 |
| `same_language_expansion` | `60f44726-89a3-4d0f-b0f9-870dede78e1a` | completed | 40 | 6 | 83,400 |

第四档有一个 Provider 请求在超时后进入 unknown-charge。它通过现有治理脚本按
预留额 `27,600 micros` 保守核销，保留失败和无结果证据，没有重放付费请求。

第五档使用前端相同形式的
`manual:<epoch>:<uuid>` refill key，经现有 Recommendation Refill Workflow
执行成功。该路径修复了 LOCAL_PRODUCT 运行时此前只接受确定性
`commercial-refill:*` key、拒绝前端 manual key 的合同不一致。

最终 Job：

```text
jobId=88666716-873e-40f6-9701-831ee19afafc
status=success
step=ready_inventory_stored
progress=100
startedAt=2026-08-10T10:59:21.792Z
finishedAt=2026-08-10T11:07:52.651Z
refillState=exhausted
terminationReason=TIERS_EXHAUSTED
```

最后一档有 `6` 个适合度合格候选。Contact Batch
`5f9d24ae-644c-477d-8299-608f17491e32` 完成 `6/6`：

- `1` 个有合规公开邮箱并进入 `PUBLISHED`；
- `5` 个未发布，原因包括 CAPTCHA、Contact Form only、Partial 和 Manual
  Review；
- 最终 `candidateReadyCount=5`、`publishedContactReadyCount=1`；
- 当前发布 High Watermark 为 `10`，五档已耗尽，因此明确返回
  `TIERS_EXHAUSTED`。

## 6. Provider 治理与预算

最终本地状态：

```text
DataForSEO enabled=true
DATAFORSEO_MAX_PAID_CALLS=250
GrowthOS cycle limit=1,000,000 micros
spent=710,616 micros
reserved=0
remaining=289,384 micros
selected-project settled ledger entries=75
selected-project ledger estimated=2,070,000 micros
selected-project ledger actual=594,000 micros
```

GrowthOS 内部周期预算、项目 Usage Ledger 和 DataForSEO 官方账户余额是三个不同
事实。本轮未查询官方账户余额，以上数值不得解释为 DataForSEO 发票或官方余额。

请求指纹、预算预留、Usage Ledger 和 Provider Batch 均归属当前 Website
Project。相同请求在同一活动 bucket 中由数据库唯一约束和 Fetch Lease 防重；
unknown-charge 未盲目重试。读取 Recommendation/Profile/Inventory、刷新页面和
切换路由不会触发付费请求。

## 7. Restart 与单一运行通道

正常完整 Restart：

```text
runId=20260810-185843
runtimeMode=LOCAL_PRODUCT
Frontend HTTP=200
FastAPI HTTP=200
Private Core HTTP=200
PostgreSQL 18=healthy
Backlinks migration head=0056
Temporal=healthy
Temporal namespace ready=true
DataForSEO enabled=true
AI enabled=true
Gmail Send enabled=true
Gmail Sync enabled=true
Browser enabled=false
```

Restart 保留了当前 Aiper Context、历史 Batch、第四档
`PROVIDER_UNAVAILABLE` 收口事实、预算 Ledger 和现有 Workflow/Job。重启后
manual refill 从同一项目策略继续第五档，而不是创建第二个 Provider、Queue、
Worker 或业务状态机。

旧格式 project-analysis Outbox Workflow ID 也在现有 Relay 中规范化为包含
Organization/Workspace/Project 的标准 ID；Temporal 已存在时按 existing
收口，避免旧事件持续占用 Relay 或重复启动。

最终只有一组 Core、一组 Backlinks Worker、一组 FastAPI 和一组 Frontend。

## 8. AI 缺口

启动状态确认：

```text
AI enabled=true
AI maxCalls=1
AI absoluteBudgetUsd=0.05
```

但当前 active Blueprint 证据为：

```text
generator=DETERMINISTIC_FALLBACK
model_version=NULL
```

即本轮没有取得可被 Schema 接受的真实结构化 AI Blueprint。安全 fallback
正确使用当前 Aiper Context、竞争对手、受众和合作目标，且真实 DataForSEO 和
推荐主流程完整继续。这是明确的 AI 输入/运行时缺口，不是 Provider、推荐、
联系人或前端失败。

下一次单独授权的 AI 修复应只定位 AI adapter 的真实结构化输出失败原因，并在
相同项目 Context 上证明 `generator=AI` 和非空 `model_version`。不得以删除
fallback、伪造模型结果或放宽 Schema 代替。

## 9. 最终 Gate

### Core

最终代码变更后重新执行：

```text
npm run verify:backlinks: PASS
typecheck: PASS
lint: PASS
source manifest: 28 records
dependency allowlist: PASS
licenses: 693 packages
Backlinks OpenAPI: 70 paths
migrations: 49 files through 0056
Unit: 104 files / 568 tests passed
API: 30 files / 103 tests passed
Contract: 27 files / 183 tests passed
Integration: 52 passed, 4 skipped files / 203 passed, 13 skipped tests
Security: 9 files / 107 tests passed
Resilience: 3 files / 8 tests passed
npm run build: PASS
```

### FastAPI 与 OpenAPI

```text
pytest: 71 passed / 1 skipped
Backlinks OpenAPI: 70 paths
Platform aggregate/shared contract: PASS
```

### Frontend

```text
typecheck: PASS
lint: PASS
Backlinks generated client: 71 operations, PASS
Platform generated client: 6 operations, PASS
production build: PASS
Playwright desktop: 6 passed
Playwright mobile 390px: 2 passed
Playwright keyboard: 1 passed
navigation/refresh/reconnect same server batch: PASS
```

### PostgreSQL 18

```text
PostgreSQL 18.4 clean install: PASS
existing upgrade and DataForSEO writes: PASS
migration/manifest through 0056: PASS
RLS and project isolation: PASS
backup/restore: PASS
RPO=0.524s
RTO=51.559s
```

### 工作树

```text
git diff --check: PASS
branch=外链part
HEAD=d796989207cd7dfdec4c0a3fdbc46f855bf0fff9
commit=not performed
push=not performed
```

工作树中的 `LOCAL-PRODUCT-000..032`、Gmail 和 Migration `0056` 既有变更均
保留，没有回退或重写。

## 10. 禁止项复核

- 真实 Gmail 发送：`0`
- Aiper Send Intent：`0`
- Aiper Send Attempt：`0`
- Aiper Placement：`0`
- Aiper Link Monitor Run：`0`
- Aiper Inventory Monitor Run：`0`
- 新 Provider：`0`
- 新 Queue：`0`
- 新 Worker：`0`
- 新业务权威：`0`
- Commit：`0`
- Push：`0`

DataForSEO、Gmail Send 和 Gmail Sync 保持独立启用与故障隔离。Recommendation
仍需用户确认后才创建 Opportunity；AI 不发送邮件，也不直接改变业务生命周期。

## 11. 验收映射

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 新项目无需代码特判生成 Blueprint | PASS | 三类别 Context/Blueprint 定向测试，生产代码无项目域名分支 |
| 无跨项目输入、候选、联系人或推荐污染 | PASS | 项目/Context 范围、RLS、Fixture 和发布库存测试 |
| 只有适合且有合规公开邮箱的网站发布 | PASS | Aiper `6` 个 fit eligible，最终仅 `1` 个 Fit/Contact 双 eligible 发布 |
| 数量不足时自动分层补货 | PASS | 五档均有 Batch 和 attempted tier 事实 |
| 所有层级不足时返回明确终态 | PASS | `refillState=exhausted`、`terminationReason=TIERS_EXHAUSTED` |
| 点击一次后持续同步并自动展示 | PASS | LOCAL-PRODUCT-032 前端 Gate 和最终 Contact Batch 自动刷新 |
| 推荐理由、Provider 和联系人证据可理解 | PASS | v3 评分、市场层级、DataForSEO 指标和联系人 reason code |
| DataForSEO 预算无回归 | PASS | `1,000,000 micros`、`250` calls、Ledger settled、reserved `0` |
| Gmail/Opportunity/监控边界无回归 | PASS | Send/Attempt/Placement/Monitor 均为 `0`，既有能力保持启用或不变 |
| 真实结构化 AI Blueprint | GAP | AI 已配置，但当前仍为安全 fallback，故最终状态为 `PASS_CODE_AI_INPUT_REQUIRED` |

## 12. 停止

`LOCAL-PRODUCT-033` 已完成并写入本 Result。未执行后续编号，未重写
`LOCAL-PRODUCT-000..028`，未 commit，未 push。
