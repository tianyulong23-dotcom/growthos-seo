# LOCAL-PRODUCT-016 联系人自动预热与公开邮箱发布硬门禁

- 执行日期：`2026-08-06`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-016`
- 最终状态：`PASS_WITH_QUALITY_BACKLOG`
- Branch：`外链part`
- Baseline HEAD：`7cf0d479aee210d2d77c2fbad523958e9a78adca`
- 最终本地运行 ID：`20260806-175807`
- Organization：`11111111-1111-4111-8111-111111111111`
- Workspace：`cec65d3f-92e5-4b13-aa26-7b39e74e213a`
- Stop boundary：未执行 `LOCAL-PRODUCT-017`

## 1. 结论

新 Candidate/历史待补 Recommendation 已进入项目级 Contact Enrichment Batch，不需要用户逐条点击。
公开推荐查询只返回 `PUBLIC_EMAIL_FOUND` 且通过用途、证据和置信度门禁的记录，并冻结默认联系人及
证据快照。仅表单、登录墙、验证码、无公开邮箱和人工复核记录保留在本批未发布摘要，不能创建
Opportunity。

AWOL 真实 Canary 使用 `21` 个不同网站完成同一批次：

- `4` 条 `PUBLIC_EMAIL_FOUND` 并发布；
- `17` 条未发布；
- `21/21` Job 进入明确终态；
- 用户可见 Recommendation 的 verified public email coverage 为 `100%`；
- 发布记录 evidence completeness 为 `100%`；
- 发布记录重复联系人为 `0`；
- 最终有界重试 P95 为 `48.283s`，最大为 `51.706s`，满足含 Browser 动态兜底 `<=60s`。

本轮没有新增 DataForSEO 请求、费用、Gmail SendIntent 或 SendAttempt。最终已把 Browser 恢复为默认
关闭，DataForSEO、AI、Gmail Sync 和 Gmail Send 也保持关闭。

## 2. 自动预热与恢复

- Candidate 进入 ready inventory 后自动创建 Contact Enrichment Job 和当前 Context 的 Batch。
- 同一 `project + recommendation + context version` 由数据库唯一约束保持一个有效 Job。
- production runtime 对 active Project Scope 执行 reconciliation，补齐历史未发布、Worker 停机和暂时
  失败留下的 Job。
- 单条重试和“仅重试未发布”在执行时读取当前 Browser capability，避免 Job 沿用过期配置。
- Job retry 会重置本次 `started_at`，批次 SLA 以当前尝试计时。
- Worker 重启后继续读取相同 Batch/Job，不创建重复记录。
- Contact Job 完成后，在同一 tenant transaction 中执行发布判定并刷新批次终态。

## 3. 抓取链与终态

抓取链复用 SafeFetch、Cheerio、validator.js、tldts、robots policy 和共享 Browser Worker：

- 首页、导航、页脚、robots/sitemap 与有界常见联系路径；
- `mailto`、可见文本、常见文本混淆和 JSON-LD；
- 最多访问 `8` 页；
- 静态页面为 JS 空壳且不属于挑战页时，最多一次 Browser fallback；
- 不做 SMTP 探测、不猜邮箱、不绕过 robots、401/403、验证码、登录墙或付费墙。

每个终态均保存：

- `pages_visited`
- `evidence_count`
- `method`
- `terminal_reason_code`
- `last_error_category`
- `completed_at`

最终 `21` 个 AWOL Job 的字段完整性检查：

| 检查 | 结果 |
| --- | ---: |
| 缺少终态原因 | 0 |
| 缺少 completedAt | 0 |
| method 为 none | 0 |
| 负数 visited/evidence count | 0 |

真实终态分布：

| 终态 | 数量 | 是否公开 |
| --- | ---: | --- |
| `PUBLIC_EMAIL_FOUND` | 4 | 是 |
| `CONTACT_FORM_ONLY` | 5 | 否 |
| `LOGIN_REQUIRED` | 4 | 否 |
| `CAPTCHA_OR_BOT_CHALLENGE` | 1 | 否 |
| `NO_PUBLIC_EMAIL` | 3 | 否 |
| `MANUAL_REVIEW_REQUIRED` | 1 | 否 |
| `COMPLETED_PARTIAL` | 3 | 否 |

## 4. 发布硬门禁与不可变证据

新增严格的 Recommendation publication service。只有以下条件同时成立才写入
`publication_status=PUBLISHED`：

- Job 终态为 `PUBLIC_EMAIL_FOUND`；
- Contact Candidate 语法有效且不是 guessed/no-reply/占位邮箱；
- 用途属于 editorial、partnership、advertising、business、marketing、site owner 或 general；
- Contact、purpose 和 evidence confidence 达到规则门槛；
- 邮箱在候选网站公开页面上有归属证据。

privacy、legal、abuse、security、billing、jobs 和 no-reply 用途不会发布。第三方 Gmail/QQ/Outlook
地址只有在候选网站公开页面存在现场证据时才允许发布，Recommendation 的网站身份仍取候选网站。

每条发布记录固定：

- `contact_evidence_snapshot_id`
- `default_contact_candidate_id`
- `default_contact_source_url`
- `default_contact_email_sha256`
- `default_contact_email_reference`
- `contact_collected_at`
- `contact_rules_version`

数据库最终证明：

| 检查 | 结果 |
| --- | ---: |
| 已发布 / 未发布 | 4 / 17 |
| 已发布但终态不是 PUBLIC_EMAIL_FOUND | 0 |
| 已发布但缺少冻结字段 | 0 |
| 冻结快照不匹配 | 0 |
| 发布快照 / 不同默认联系人 | 4 / 4 |

联系人后续失效时，新机会入口会把 Recommendation 转为 `CONTACT_REVIEW` 并隐藏；已创建 Opportunity
继续保留原不可变证据，不静默更换收件人。Opportunity repository 也会重新校验 Recommendation
仍为 `PUBLISHED` 且提交的联系人等于冻结默认联系人。

## 5. 数据库、API 与合同

- 新增 Backlinks migration：`0046_backlink_contact_publication_gate.sql`。
- Migration 增加 Contact Batch、Job 终态字段、不可变 Contact Evidence Snapshot、publication
  constraint、默认联系人冻结字段和 published-contact-ready watermarks。
- Migration 已在真实 PostgreSQL 18 数据库成功应用；Backlinks head 为 `0046`。
- Deployment manifest 已注册 migration checksum：
  `555c082f27bb41d98b44f851fec773fd24cbed8865d95367e5daea62ef4ec5ee`。
- Core 与 FastAPI 增加项目级“仅重试未发布”路由。
- 公开 Recommendation 查询在服务端只读取 `PUBLISHED`、verified email 和完整 snapshot。
- Backlinks OpenAPI、Platform OpenAPI 和 generated frontend client 已同步。
- Backlinks OpenAPI baseline：`59` paths。
- Generated Backlinks client：`60` operations。

## 6. 前端一次等待体验

推荐池实现：

- 只渲染已发布 Recommendation；
- 卡片直接显示冻结邮箱、用途、联系人/用途置信度和来源页面；
- 只有一个“等待本批可联系推荐”入口，不存在逐条发现联系人按钮；
- 前台最多等待 `60s`，超时显示精确文本 `后台继续处理中`；
- Batch ID 和 Context 保存在 `sessionStorage`，离开、刷新或切换项目后按项目恢复同一批次；
- 显示 Candidate、已发布、未发布、终态数量及按 reason 分组的摘要；
- “仅重试未发布”只作用于未发布记录；
- 加入 Opportunity 只出现在已发布卡片；
- 页面不存在“暂无联系人”推荐卡片。

Playwright 真实验收证据：

- `output/playwright/local-product-016-awol-recommendations-desktop.png`
- `output/playwright/local-product-016-awol-recommendations-mobile-390.png`
- `output/playwright/local-product-016-elephtv-isolation-desktop.png`

桌面和 `390px` 页面均显示 AWOL `4` 条公开联系人、`17` 条未发布和 `21/21` 批次终态，未发现控件
重叠或文本遮挡。切换至 ElephTV 后只显示该项目自己的资料缺失状态，没有 AWOL Contact、Evidence、
Job 或 Recommendation 数据。

## 7. 性能修复与真实 Canary

第一次 Browser-enabled 重试中，robots.txt 被每个页面重复请求，导致批次 P95 超过 `60s`。修复后：

- `RobotsPolicyAdapter` 在单个 Job 内缓存 robots document promise；
- 同一站点的多个页面复用一次 robots fetch 和 parse；
- Adapter 生命周期限制在单个 claimed Job，避免跨站点或长期 stale cache。

针对未发布记录执行第二次有界重试：

| 指标 | 结果 |
| --- | ---: |
| 重试 Job | 17 |
| P95 | 48.283s |
| 最大耗时 | 51.706s |
| 批次最终完成 | 21/21 |

## 8. Project 隔离与零副作用

### AWOL

- Website Project ID：`4ec81dca-a0d0-40f3-9ff1-9cdff6613924`
- Context：`06420fcb-7dfc-4e53-9928-17a434d13ad4`
- Batch：`97c7b568-0645-4e85-b024-9e7631e6da53`
- Job / inventory：`21 / 21`
- Published / unpublished：`4 / 17`

### ElephTV

- Website Project ID：`e0bfde33-54bd-454a-ab61-cf7a4a48dcf0`
- Context：`2b47d887-c024-4704-b58e-198d251efea5`
- 当前 Context Job：`0`
- 当前 Context inventory：`0`
- Playwright 页面未出现 AWOL 数据。

从最终 Browser-enabled 验收开始时间 `2026-08-06T09:47:47Z` 统计两个项目的副作用增量：

| 事实 | 增量 |
| --- | ---: |
| Provider requests | 0 |
| Provider usage ledger rows | 0 |
| Paid cost | 0 micros |
| Commercial discovery batches | 0 |
| Gmail SendIntent | 0 |
| Gmail SendAttempt | 0 |

历史数据库中存在 016 之前的 Provider 使用记录，本节只声明本轮增量为零。

## 9. 最终运行状态

最终通过正式 restart 脚本恢复 Provider 全关闭配置：

| 组件/能力 | 结果 |
| --- | --- |
| Frontend `5173` | listening |
| FastAPI `7200` | HTTP 200 |
| Backlinks Core `7301` | HTTP 200 |
| PostgreSQL `55432` | listening / healthy |
| Browser Worker `7401` | 未监听 |
| DataForSEO | disabled |
| AI | disabled |
| Gmail Sync | disabled |
| Gmail Send | disabled |
| Browser | disabled |

最终运行 ID：`20260806-175807`。

## 10. 验证

| 检查 | 结果 |
| --- | --- |
| Contact Activity/Parser/Purpose/Publication/Robots/Runtime focused suite | 8 files / 41 tests passed |
| API/Contact discovery/Outbox focused suite | 4 files / 14 tests passed |
| Contact discovery real-schema integration fixture | 3 tests passed |
| Robots per-job cache focused suite | 4 files / 31 tests passed |
| Core TypeScript typecheck | passed |
| Core build | passed |
| FastAPI Gateway/migration/PostgreSQL contract | 24 passed, 1 skipped |
| Frontend TypeScript typecheck | passed |
| Frontend Recommendation source contract | 2 passed |
| Backlinks OpenAPI check | 59 paths passed |
| Backlinks migration check | 39 files through `0046` passed |
| Playwright desktop / 390px / project switch | passed |
| Git whitespace check | no errors; existing LF/CRLF warnings only |

## 11. Quality Backlog

功能、发布门禁、事务约束、API Contract、项目隔离、真实终态和 `<=60s` 动态 SLA 已通过。以下质量
校准不应伪装为已完成：

- 本批 Browser fallback 为 `14/21 = 66.7%`，高于初始目标 `<=15%`。该批是对历史未发布网站的
  集中重试，包含 JS、受限和失败站点，不能代表新鲜随机流量；仍需在后续新库存上降低 fallback。
- `21` 站 Canary 没有完整人工真值标签，因此不声明公开邮箱 Precision/Recall、用途 Macro F1 或
  no-contact reason accuracy 已达到生产目标。
- 按任务正文，`100` 站人工校准保留为 `QUALITY-BACKLOG`，不阻塞 `LOCAL-PRODUCT-017`。后续应使用
  已建立的可扩展标注/回归结构补齐公开邮箱、仅表单、无邮箱、JS、403/挑战和登录墙样本，并输出
  Precision、Recall、错误邮箱率、用途 Macro F1、原因准确率与 fallback 比例。

因此本任务状态为 `PASS_WITH_QUALITY_BACKLOG`，而不是无条件宣称全部质量指标已完成。

## 12. 边界

- 未执行 `LOCAL-PRODUCT-017`。
- 未提交或推送 Git。
- 未读取、复制或持久化 Gmail、DataForSEO 或其他 Provider 凭据。
