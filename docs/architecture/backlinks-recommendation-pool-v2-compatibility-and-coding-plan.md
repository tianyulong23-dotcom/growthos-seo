# 外链推荐池 V2 兼容性审计与 Coding 实施文档

| 项目 | 内容 |
| --- | --- |
| 文档状态 | `READY_FOR_IMPLEMENTATION_REVIEW` |
| Task ID | `BACKLINKS-RECOMMENDATION-POOL-V2-COMPATIBILITY-CODING-PLAN-001` |
| 产品依据 | `docs/architecture/backlinks-recommendation-pool-product-requirements-v2.md` |
| 目标仓库 | `C:\Users\DELL\Documents\缝合\john3947-seo-main` |
| 审计分支 | `main` |
| 审计 HEAD | `7df8d48d088328bd79fb0a1afef364b17cc8b6af` |
| 编写日期 | 2026-08-28 |
| 本轮证据级别 | `STATIC_COMPATIBILITY_AUDIT` |
| 文档编制阶段边界（已结束） | 2026-08-28 编制本文件时仅允许新增 Coding 文档，不修改业务代码、数据库或配置；后续 Coding task 以第 17 节任务合同和用户明确授权为准 |

## 1. 文档结论

新的推荐池逻辑不能直接覆盖当前 `recommendations` 查询、当前项目级
`archivePool` 命令或当前前端“归档并生成下一轮”流程。

直接修改现有逻辑会产生以下实质冲突：

1. 当前读路径把评分、准入门槛和当前 `visible_pool_generation` 当作可见性依据，V2 要求指标不作为硬淘汰条件，并读取用户历次已释放批次。
2. 当前 `CONTACT_PENDING` 可以展示，V2 要求联系方式达到终态后才可发布。
3. 当前归档会修改项目级库存、创建下一代并可能进入付费补池；V2 归档只能影响当前用户，不得释放下一批或调用供应商。
4. 当前加入 Opportunity 会把推荐和库存状态改成 `accepted`；V2 要保留推荐网站，并只把真正由当前用户新建的 Opportunity 计入 25% 分子。
5. 当前前端以 `localStorage` 保存补池操作状态；V2 的用户游标、18 小时起点和解锁状态必须以服务端用户身份为准。
6. 当前发现入口在关键词和目标 URL 同时为空时拒绝运行；V2 必须先根据项目事实自动生成并验证种子，再进入现有发现链路。
7. 当前周期 Worker 和 project-analysis 完成回调会进入 V1 自动 refill；若不加
   contract guard，V2 项目可能被旧低水位策略重复补池并产生额外成本。
8. 当前 Opportunity 创建要求完整 recommendation/prospect/inventory 和
   generation/input pin 身份；V2 batch 若只保存网站会在“加入机会”处断链。
9. 联系方式达到爬取终态不代表存在可发送联系人；无邮箱网站可以保留并进入
   `contact_review_required` Opportunity，但不能绕过 Draft/Send 联系人门槛。
10. Draft、Send、Reply、Placement 和 Reports 已经以现有 Opportunity 为主链；
    V2 必须通过该主链接入，不能让用户 cursor、归档或批次状态改写下游事实。

因此本计划采用：

```text
保留现有 V1 推荐、发现、资格、联系方式和 Opportunity 事实
-> 新增 recommendation-pool.v2 发布契约和用户发布层
-> V2 前端只读取新的 recommendation-feed API
-> 通过代次契约版本渐进切换
-> 完成迁移和回归后再废弃旧交互
```

这不是建立第二套 DataForSEO、AI、爬虫、任务队列或 Opportunity
系统。V2 新增的是业务发布层、用户进度层和兼容投影，底层能力继续复用。
完成本文新增的后台 contract guard、canonical identity bridge、下游证据投影和
跨模块回归门后，静态架构层面没有仍未给出解决路径的严重外链板块冲突。

## 2. 当前工作区事实

### 2.1 Git 与并发修改

审计时工作区不是干净状态，推荐池后端、Runtime、Workflow、前端和测试均有未提交修改。
本文件把当前工作区内容视为审计事实，不把 `HEAD` 单独视为当前实现。

主要并发修改区域包括：

- `backend/core/src/modules/backlinks/api/recommendation-commands.route.ts`
- `backend/core/src/modules/backlinks/application/commands/recommendations.command.ts`
- `backend/core/src/modules/backlinks/application/services/commercial-*.ts`
- `backend/core/src/modules/backlinks/domain/recommendations/*.ts`
- `backend/core/src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts`
- `backend/core/src/modules/backlinks/runtime/production-runtime.ts`
- `backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.ts`
- `frontend/src/features/outreach/recommendations/recommendations-workspace.tsx`
- `frontend/src/features/outreach/recommendations/promotion-target-setup.tsx`

执行 Coding 前必须重新记录：

```text
git root
remote
branch
HEAD
git status --short
相关文件 diff
最新迁移编号
```

不得回退、覆盖或格式化用户现有修改。新实现优先增加独立文件和加法式数据库结构，
对上述大文件的接线修改安排在各阶段末尾单独完成。

### 2.2 当前迁移头

审计时 Backlinks SQL 目录的最新迁移为：

```text
0079_backlink_send_intent_resubmission.sql
```

目录中没有 `0077`。本计划不得预占固定迁移编号。实施阶段必须先重新扫描迁移目录，
选择当时下一个可用编号，并运行仓库现有迁移顺序与不变性检查。

## 3. 自研还是引入开源模块

### 3.1 决策

推荐池 V2 的业务规则由项目代码实现，不引入新的通用“推荐系统”“任务队列”
“爬虫框架”“状态机”“规则引擎”或“分页框架”。

首轮实现目标是：

```text
新增运行时依赖数量 = 0
```

理由：

1. 25% 行为解锁、18 小时解锁、项目级规范批次、用户级游标、隐藏池保密、
   Opportunity 去重和两轮 1 USD 预算是本产品专属规则，通用推荐库不能直接解决。
2. 当前项目已经有持久任务、供应商账本、请求指纹、租约、重试、审计、RLS、
   域名归一化和联系方式爬取能力。再引入框架会形成第二套事实和恢复模型。
3. 当前主要风险是旧推荐池语义与新语义冲突，不是缺少一个排序算法或开源组件。
4. V2 不需要机器学习在线推荐系统。它需要确定性、可审计、项目隔离的发布策略。

### 3.2 继续复用的现有组件

| 能力 | 现有组件 | V2 使用方式 |
| --- | --- | --- |
| 长任务与恢复 | Temporal TypeScript SDK | 继续承载发现、资格补充、联系方式和批次准备；不创建第二套队列 |
| 数据与事务 | PostgreSQL、`pg`、Drizzle | 新增事实表、RLS、唯一约束、事务和 advisory lock |
| DataForSEO | 当前 DataForSEO adapter、request ledger、usage ledger、fetch lease | 继续执行竞争对手、来源域、Traffic、Rank、Spam 请求和成本控制 |
| AI 结构化输出 | 当前 AI SDK、Zod schema、商业发现 Blueprint | 扩展种子生成、验证、补充和来源记录，不新建第二套 AI 发现引擎 |
| 域名归一化 | `tldts` 与现有 canonical domain 规则 | 统一根域、IDN 和去重键；不手写后缀列表 |
| 联系方式 | 现有 Contact Enrichment command、Crawler、Browser fallback | 对待释放批次执行，复用终态和重试模型 |
| API | Fastify、Zod、OpenAPI 生成链 | 新增 V2 endpoint 和生成客户端 |
| 前端服务端状态 | TanStack Query | 查询发布池、解锁状态和服务端命令结果 |
| 审计与幂等 | 当前 lifecycle、audit、idempotency 表 | 所有发布、获取更多、归档和 Opportunity 计数继续留痕 |

官方能力复核入口：

- [Temporal TypeScript 开发文档](https://docs.temporal.io/develop/typescript)
- [PostgreSQL Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [DataForSEO Bulk Traffic Estimation](https://docs.dataforseo.com/v3/dataforseo_labs-google-bulk_traffic_estimation-live/)
- [DataForSEO Bulk Spam Score](https://docs.dataforseo.com/v3/backlinks-bulk_spam_score-live/)
- [DataForSEO Bulk Ranks](https://docs.dataforseo.com/v3/backlinks-bulk_ranks-live/)
- [DataForSEO Backlinks Competitors](https://docs.dataforseo.com/v3/backlinks-competitors-live/)
- [`tldts` 官方仓库](https://github.com/remusao/tldts)

DataForSEO endpoint、字段、分页和价格在实施前必须再次对照官方当前文档和账号实际返回。
本文不把审计日看到的供应商细节冻结成永久契约。

## 4. 需求与当前代码冲突矩阵

| 需求面 | 当前代码事实 | 冲突等级 | 无冲突处理 |
| --- | --- | --- | --- |
| 无关键词、无竞争对手也可发现 | `local-product-dataforseo-runtime.ts` 在关键词和目标 URL 同时为空时拒绝运行 | 高 | 在现有 readiness gate 前增加 Seed Preparation；生成、验证并持久化有效种子后再调用现有发现服务 |
| 用户输入保留并可被补充 | Blueprint 已支持查询簇和竞争对手种子，但缺少逐条来源、验证状态和替换历史 | 中 | 新增 seed fact 表；Blueprint 继续作为不可变发现方案，不覆盖用户原值 |
| 最多两轮、每轮 1 USD | 当前 refill 是库存水位驱动，可进入持续补池 | 高 | V2 初始建池增加独立 budget round policy；第二轮仅在 `<100` 且请求策略变化时允许；累计上限 2 USD |
| V1 后台 Worker 不得给 V2 自动补池 | `production-runtime.ts` 的周期恢复扫描和项目分析完成回调都会调用 `ensureCommercialRecommendationRefill`，当前没有 V2 contract guard | 阻断 | 所有 V1 refill、recovery、reservation、relay 和项目分析入口先读取 `pool_contract_version`；V2 返回 `contract_not_applicable`，不创建 job/outbox/provider reservation |
| 获取更多不请求供应商 | 当前“归档并生成下一轮”会进入 `awaiting_refresh` 并可创建 refill | 阻断 | 新增用户发布命令；V2 UI 不调用旧 archive/refill endpoint |
| 指标不作硬淘汰 | 当前候选、资格、查询和归档复制均依赖 `eligible`、score model 和 applied threshold | 阻断 | V2 发布资格只执行安全、有效域名、去重和明显无关排除；Traffic/Rank/Spam 作为可空展示与筛选事实 |
| 不显示评分 | 当前 API 和 UI 返回、展示 score、priority、risk、score model 和内部 fitDecision | 高 | 新 V2 response 不包含数值评分和内部模型；只返回 `recommended` 和理由代码/文案 |
| 联系方式终态后展示 | 当前查询允许 `PUBLISHED` 和 `CONTACT_PENDING` | 阻断 | V2 发布只读新 batch item 的 terminal snapshot；新代次禁止 `CONTACT_PENDING` 发布 |
| V2 网站可加入现有 Opportunity | 当前 `createFromRecommendation` 强依赖 recommendation、prospect、inventory、generation/input pin，并检查旧 commercial policy | 阻断 | V2 item 在 PREPARING 前必须物化完整规范身份；新增 V2 entitlement-aware Opportunity 接入分支，不放宽 V1 查询 |
| 联系方式终态不等于可发送 | V2 允许“联系页面、未找到、抓取失败”终态；现有 Draft/Send 仍需要有效 contact | 高 | 网站仍可展示并可创建 `contact_review_required` Opportunity；没有有效联系人时继续阻止草稿/发送，不伪造邮箱 |
| AI 草稿继续获得推荐上下文 | 当前 Draft 查询只优先读取旧 v3 score/candidate，缺失时虽然不报错但上下文会退化 | 中 | 增加版本无关的 Opportunity evidence snapshot/read adapter，优先读取 V2 release reason、指标和上下文，旧数据继续 fallback |
| 发送、回复、Placement、报告不改主链 | 这些模块从 Opportunity/Draft 或 Opportunity ID 往后处理 | 低 | V2 只替换发现和发布读路径；成功创建现有 canonical Opportunity 后，继续走原有 Draft、Send Intent、Reply、Placement、Reports 生命周期 |
| 历次已释放结果共同筛选 | 当前查询只读取当前 `visible_pool_generation` | 高 | 用户发布记录作为 entitlement；查询所有已发布批次减去该用户归档 |
| 规范批次项目内一致 | 当前代次是项目库存代次，不是固定的用户发布批次 | 高 | 新增 project/context/generation 级 canonical batch 和稳定顺序指纹 |
| 用户进度独立 | 当前没有用户级批次游标 | 高 | 以 `PlatformRequestContext.v1.actor.userId` 建立用户游标、发布和解锁事实 |
| 同账号多设备共享 | 前端部分流程以 `sessionId`/`localStorage` 辅助操作恢复 | 高 | 权威键只使用 `userId`；`sessionId` 只用于诊断，`localStorage` 不参与业务判断 |
| 不同用户互不推进 | 当前项目库存状态对所有成员共享 | 高 | Canonical batch 共享，publication/cursor/unlock/archive 按用户隔离 |
| Opportunity 项目级去重 | 当前已有 `(website_project_id,target_site_key)` 唯一冲突保护 | 无冲突 | 原样复用；已有团队 Opportunity 不再创建 |
| 只计算当前用户真正新建的 Opportunity | 当前成功创建后把库存和推荐改成 `accepted`，没有 V2 用户批次分子事实 | 高 | 在同一事务写入 `OPPORTUNITY_CREATED` 用户动作；只有 `created` 分支计数 |
| 加入 Opportunity 后保留网站 | 当前状态转为 `accepted`，部分旧 UI/查询可能改变展示 | 中 | V2 feed 不以 `accepted` 排除；返回 `existingOpportunity` 和 `teamAdded` |
| 归档不触发补位或发现 | 当前 `archivePool` 会归档整代、复制候选并进入下一代 | 阻断 | 新增 actor-scoped item archive；批量归档只是批量写用户归档动作 |
| 归档不计入 25% | 当前归档没有用户解锁模型 | 高 | 解锁 SQL 只统计当前用户成功创建 Opportunity 的唯一 batch item |
| 18 小时解锁 | 当前没有该事实 | 高 | 使用服务端 `first_visible_at` 和数据库时钟计算；不为每个用户创建 Temporal timer |
| 筛选只读已释放池 | 当前 API 支持 `minScore`，前端获取 100 条后可在内存处理 | 高 | 新 feed 在数据库执行过滤、排序、游标分页和导出；所有查询从 entitlement 开始 |
| 隐藏池不可泄露 | 当前 inventory response 返回多种内部库存和 refill 计数 | 高 | V2 用户 response 不返回隐藏总量、未释放数量、预算、tier、请求指纹和内部终止细节 |
| 核心输入变化创建新代次 | 当前已有 context/version 和 supersession 机制 | 低 | 复用 context pin；新增 release contract version，保留历史用户发布和 Opportunity |
| 项目归档、删除和 context supersession | 现有 supersession 只识别 `recommendation_refill`，项目删除通过批量 facts/storage adapter 执行 | 高 | V2 job 必须接入 stop/supersession；旧 context 禁止再 AVAILABLE；新表进入删除顺序或明确 FK cascade，已创建 Opportunity 历史不被用户游标动作改写 |
| 新逻辑与旧数据库约束共存 | `0071` 等迁移把旧 `PUBLISHED` 与 v4 资格事实绑定 | 阻断 | V2 发布写入独立 release 表，不伪装成旧 publication；旧约束保持有效 |
| 推荐页状态不污染其他外链页面 | 当前 recommendations、opportunities、email、links、reports 在同一 workspace 路由下但各有查询状态 | 中 | 只替换 recommendations view/query namespace；创建 Opportunity 后只精确失效 V2 feed 和 Opportunities，不清空 Mail/Links/Reports 权威状态 |
| 当前脏工作区 | 核心推荐文件有大量未提交修改 | 阻断性执行风险 | 先完成加法式模块；每阶段开始重新审计 diff，接线文件单独处理，禁止覆盖现有工作 |

## 5. 目标架构

### 5.1 单一业务链

```text
项目事实与用户输入
-> Seed Preparation
-> Blueprint 生成、验证与版本固定
-> DataForSEO 多来源发现
-> canonical domain 去重与必要排除
-> Traffic / Rank / Spam 补充
-> 发现代次完成并冻结有效唯一数量 T
-> 创建 Canonical Batches
-> 对当前待释放批次执行联系方式爬取
-> 联系方式全部终态
-> Canonical Batch AVAILABLE
-> 按用户创建 Publication
-> 用户查看、筛选、归档、加入 Opportunity
-> 25% 或 18 小时后解锁
-> 用户点击“获取更多”
-> 发布下一个已有 Canonical Batch
```

`获取更多`之后不存在发现箭头，也不存在 DataForSEO 调用。

### 5.2 迁移期 V1/V2 隔离策略

不在同一个查询中混合两套可见性规则。代次契约明确声明：

```text
pool_contract_version = recommendation-pool.v1
或
pool_contract_version = recommendation-pool.v2
```

规则：

1. V1 代次继续由现有 `/recommendations`、inventory、archive/refill 路径读取。
2. V2 代次只由新的 `/recommendation-feed` 路径读取。
3. 前端根据服务端返回的 contract version 选择视图，不用浏览器特性开关猜测。
4. 新建或重新生成的推荐池在 V2 迁移完成后使用 V2。
5. 旧 API 在 V2 稳定前保留，但 V2 UI 不显示旧“归档并生成下一轮”操作。
6. 不修改已应用迁移去重写旧语义。
7. 所有周期 Worker、project-analysis hook、recovery、reservation、outbox relay
   和旧手工 refill 命令都必须按 contract version 分流，不能靠 UI 隐藏来隔离。
8. V2 进入后续外链链路的唯一出口是现有 canonical Opportunity，不创建
   `Opportunity V2`、第二套 Draft、第二套发送或第二套 Placement。
9. V1/V2 并存只允许作为实施和历史迁移期间的临时状态，不是产品完成状态。
10. 全量切换完成时，所有可进入 Backlinks 推荐池的未删除项目必须使用 V2，
    不得存在活跃 V1 generation 或仍依赖 V1 生成结果的用户读路径。
11. 全量切换后，V1 recommendation generation、refill、recovery、reservation、
    relay、手工命令和供应商请求入口必须全局停止创建新事实；V1 历史数据只读保留。

### 5.3 状态拆分

不得再用一个 inventory status 同时表达发现、联系方式、用户发布和 Opportunity。

独立事实至少包括：

```text
Discovery Generation
Discovery Seed
Provider Request / Usage
Candidate
Metric Snapshot
Contact Job / Terminal Outcome
Canonical Batch
Canonical Batch Item
User Publication
User Cursor
User Unlock
User Item Action
Opportunity
User Archive
```

产品汇总状态由这些事实投影得到：

```text
BUILDING
ENRICHING
PREPARING_BATCH
READY
UNLOCKED
PARTIAL_EXHAUSTED
POOL_EXHAUSTED
FAILED
```

### 5.4 外链板块下游兼容边界

V2 的所有权边界止于“把一个已发布网站安全地转换为现有 Opportunity”。

```text
V2 Seed / Discovery / Batch / User Publication
-> canonical Recommendation + Prospect + Inventory lineage
-> existing backlink_opportunities
-> existing Draft
-> existing Send Intent / Gmail
-> existing Reply
-> existing Placement
-> existing Reports / Metrics
```

硬约束：

1. V2 不修改 Opportunity 之后的业务状态机、cycle、contact、draft、send、
   reply、placement 和 report 表语义。
2. `archive`、`unarchive`、`get-more` 和用户 cursor 只能写 V2 用户事实，
   不得更新或删除已经存在的 Opportunity、Draft、Send、Reply 或 Placement。
3. V2 release 的联系方式终态只说明“爬取已完成”。如果没有合格邮箱或人工确认
   contact，Opportunity 可以进入 `contact_review_required`，但 Draft/Send
   继续使用现有联系人门槛。
4. V2 的推荐理由和指标必须通过不可变 selection/evidence snapshot 交给
   Opportunity/Draft；用户响应不显示数值评分，内部也不能把旧 v3 score
   作为 V2 下游可用性的必需条件。
5. 下游模块只认 canonical Opportunity ID 和现有项目身份，不直接读取用户批次
   cursor 来决定发送、回复、Placement 或报告状态。

## 6. 数据模型更新

以下名称是目标命名。最终迁移可以按仓库命名规范微调，但不得合并不同事实。

### 6.1 扩展代次契约

对现有 `backlink_recommendation_generation_contracts` 加法式增加：

```text
pool_contract_version
seed_contract_version
release_contract_version
recommendation_marker_version
discovery_budget_policy_version
effective_unique_candidate_count
canonical_batch_size
canonical_batch_count
canonical_order_fingerprint
discovery_terminal_reason
discovery_completed_at
```

不可变字段在代次完成后不得更新。输入变化创建新 context/generation。

### 6.2 发现种子事实

新增 `backlink_commercial_discovery_seeds`：

```text
id
tenant/project/context/generation keys
seed_kind: KEYWORD | CATEGORY | SEO_COMPETITOR
raw_value
normalized_value
source:
  USER_INPUT
  USER_TRIGGERED_GENERATION
  SYSTEM_FALLBACK
  SYSTEM_SUPPLEMENT
validation_status:
  PENDING
  VERIFIED
  RETAINED_LOW_CONFIDENCE
  REJECTED
validation_reason_codes
evidence_refs
confidence_band
supersedes_seed_id
created_by / created_at
```

约束：

- 用户原始输入不物理删除。
- 同一代次的有效规范值去重。
- 系统补充不能静默覆盖用户输入。
- Blueprint 必须引用实际使用的 seed IDs 和指纹。

### 6.3 规范批次

新增 `backlink_recommendation_release_batches`：

```text
id
tenant/project/context/generation keys
batch_ordinal
state: PREPARING | AVAILABLE | RETIRED | SUPERSEDED
original_batch_size
selection_policy_version
order_fingerprint
contact_terminal_count
contact_total_count
preparation_started_at
available_at
deadline_at
```

唯一约束：

```text
(project, context, generation, batch_ordinal)
```

新增 `backlink_recommendation_release_batch_items`：

```text
id
batch_id
candidate_id
recommendation_id
prospect_id
inventory_id
generation_contract_id
input_pin_id
canonical_domain
position
recommended
recommendation_reason_codes
recommendation_marker_version
traffic_snapshot_ref
rank_snapshot_ref
spam_snapshot_ref
category_snapshot
contact_terminal_reason_at_release
contact_email_at_release
contact_page_at_release
contact_completed_at_release
legacy_imported
```

唯一约束至少包括：

```text
(batch_id, position)
(batch_id, canonical_domain)
(project, context, generation, canonical_domain)
```

除 `legacy_imported` 的受控迁移分支外，上述六个 lineage ID 在 batch item
进入 `PREPARING` 前必须全部为 `NOT NULL` 并有 tenant/project/context 一致的
复合外键。`AVAILABLE` item 必须能在同一事务追溯到：

```text
commercial candidate
-> backlink_recommendations
-> backlink_prospects
-> backlink_recommendation_inventory
-> generation contract
-> immutable input pin
```

Inventory 可保留 `ready`/`shown` 作为下游兼容状态，但不得为了 V2 可见性写成旧
`publication_status='PUBLISHED'`。V2 可见性的唯一权威仍是 release publication。

同一项目此前已经释放过的 canonical domain 不得在新代次再次作为新网站释放。
其历史记录继续可查，最新指标可以通过独立快照补充。

### 6.4 用户发布、游标和解锁

新增 `backlink_recommendation_user_batch_publications`：

```text
id
tenant/project/context/generation
user_id
batch_id
first_visible_at
publication_state: ACTIVE | ARCHIVED
published_by_command_id
```

新增 `backlink_recommendation_user_cursors`：

```text
tenant/project/context/generation
user_id
highest_published_batch_ordinal
current_batch_id
version
updated_at
```

新增 `backlink_recommendation_user_batch_unlocks`：

```text
user_id
batch_id
original_batch_size
required_opportunity_count
successful_opportunity_count
unlocked_at
unlock_reason: OPPORTUNITY_RATIO | ELAPSED_18H
evaluated_at
```

新增 `backlink_recommendation_user_item_actions`：

```text
id
user_id
batch_id
batch_item_id
action_type:
  OPPORTUNITY_CREATED
  ARCHIVED
  UNARCHIVED
  GET_MORE
opportunity_id
idempotency_key
created_at
```

动作唯一性：

- `OPPORTUNITY_CREATED` 对同一 user/batch/item 只能有一条有效计数事实。
- `GET_MORE` 必须绑定原批次和目标下一批次。
- 归档允许追加事件，但当前状态由最新投影决定。

### 6.5 RLS 和索引

所有新表必须使用现有 tenant/project RLS 模式，并建立：

- tenant/project/context/generation 复合外键和索引；
- `user_id + project + generation` 查询索引；
- batch item 的 recommended/category/traffic/rank/spam 筛选索引；
- canonical domain 唯一约束；
- Opportunity 关联索引；
- publication、cursor 和 action 的幂等唯一约束。

不能依赖应用层先查后写保证唯一性。

## 7. 核心策略

### 7.1 种子生成与验证

新增 Seed Preparation，但复用现有商业发现 Blueprint：

1. 读取不可变的 Project、SiteProfile、Outreach Profile、market 和 language 快照。
2. 合并用户关键词、分类和竞争对手。
3. 对缺失字段生成建议；对已有字段验证并补充，不覆盖。
4. 使用站点公开内容、结构化产品事实和现有搜索证据进行语义校验。
5. 只把 `VERIFIED` 或 `RETAINED_LOW_CONFIDENCE` 种子交给 Blueprint。
6. 如果一类种子不足，扩大查询簇或 SEO 竞争对手来源；目标市场、语言和业务方向不自动改变。

AI 输出是候选，不是事实。每条系统种子必须有项目证据或供应商验证结果。

### 7.2 发现轮次与预算

初始建池预算：

```text
Round 1 <= 1 USD
Round 2 <= 1 USD
Project initial discovery total <= 2 USD
```

第二轮只在以下条件同时满足时启动：

```text
Round 1 有效唯一域名 < 100
AND 仍有未耗尽发现路径
AND Round 2 的 seed/request fingerprint 与 Round 1 不同
AND 没有未决 unknown_charge
AND 项目累计授权仍在 2 USD 内
```

停止条件：

- 有效唯一域名达到 1,000；
- 已达到可安全分批供应的数量，且无需第二轮；
- 连续两个完成的发现窗口均满足：
  `new_unique_count < 5 AND new_unique_rate < 5%`；
- 本轮或累计预算达到上限；
- 所有允许的发现路径耗尽；
- 项目 context 被新版本取代；
- 出现无法确认是否扣费的 `unknown_charge`。

低产出阈值必须配置化并写入 policy version。修改阈值只能影响新代次。

隐藏池耗尽后，本期不自动开启第三轮或长期付费补池。

### 7.3 必要排除和指标

可以在进入完整发现池前排除：

- 项目自身域名；
- canonical root domain 重复；
- 语法无效或无法形成有效域名身份；
- 已确认恶意、违法、安全阻断或永久排除的网站；
- 与项目业务完全无关且可解释为噪声的结果。

不得仅因以下事实淘汰：

- 低流量；
- 低 Rank；
- 高 Spam；
- Traffic、Rank 或 Spam 缺失；
- 未找到公开联系方式。

指标快照必须保存：

```text
value or null
provider
endpoint
market/location
language
observed_at
request/artifact reference
```

`metrics.organic.etv` 只在对应目标市场和语言范围内解释为预估自然流量。
DataForSEO Rank 不得标记为 Ahrefs DR 或 Moz DA。

### 7.4 推荐标记 V1

用户不看数值评分。V2 持久化布尔值、原因和策略版本：

```text
recommended: boolean
recommendation_reason_codes: string[]
recommendation_marker_version: recommendation-marker.v1
```

`recommended=true` 的首版规则：

1. 已通过必要安全和噪声排除；
2. 至少一个已验证的相关性证据：
   - 产品或服务主题重合；
   - 受众重合；
   - SEO 竞争对手外链来源重合；
   - 目标市场搜索主题重合；
3. 至少还有一个独立正向证据类别：
   - 目标市场或语言匹配；
   - 可验证的来源域/竞争对手关系；
   - 已找到邮箱或联系页面；
   - 存在可靠 Traffic、Rank 或权威证据；
   - 存在可解释的合作路径。

现有 v4 score 可以作为一个内部输入，但不得：

- 单独决定 `recommended`；
- 作为发布门槛；
- 出现在 V2 用户 API；
- 出现在 UI、导出或筛选器。

推荐理由使用稳定 reason code 加本地化文案，不直接展示模型推理文本。

### 7.5 批次计算和稳定顺序

发现代次完成后冻结有效唯一数量 `T`。

```text
T < 25:
  batch_size = T

T >= 25:
  batch_size = min(100, ceil(T / 5))
```

示例：

| T | batch size |
| ---: | ---: |
| 18 | 18 |
| 25 | 5 |
| 100 | 20 |
| 130 | 26 |
| 500 | 100 |
| 1,000 | 100 |

顺序必须确定且冻结。首版排序建议：

```text
recommended DESC
-> recommendation reason strength band DESC
-> evidence completeness DESC
-> canonical_domain ASC
```

这里的 strength band 只用于稳定排队，不作为用户评分或淘汰门槛。
代次必须保存排序策略版本和完整顺序指纹。

### 7.6 联系方式终态

复用现有 Contact Enrichment 终态代码。以下结果可以发布：

- 找到公开邮箱；
- 只找到联系页面；
- 公开联系方式未找到；
- 登录、验证码、robots 或访问拒绝；
- 网站不可达或内容不支持；
- 重试耗尽后 `COMPLETED_PARTIAL`；
- context supersession 形成的终态快照。

`pending`、`running` 和 `retry_scheduled` 不是终态。

当前已有默认配置继续作为首版单站点配置：

```text
maxPages = 8
maxDepth = 2
maxAttempts = 3
```

批次新增独立的准备截止时间配置：

```text
RECOMMENDATION_BATCH_PREPARATION_DEADLINE_HOURS
initial default = 24
```

截止后，仍未完成的任务必须通过现有恢复命令收敛成可解释的
`COMPLETED_PARTIAL`，不能永久阻塞批次，也不能伪造成功邮箱。

批次只在所有 item 都存在 terminal snapshot 后进入 `AVAILABLE`。
发布后的手工重试可以更新最新联系方式展示，但不能撤销用户已经获得的可见权。

### 7.7 滚动准备

不一次爬取完整隐藏池的所有联系方式。服务端采用：

```text
当前需要发布的批次
+ 下一规范批次 one-batch-ahead
```

项目级联系方式只爬一次，多个用户共享同一 canonical batch 的结果。
若用户已经解锁但下一批仍在准备，按钮显示“准备中”，不得绕过终态门槛。

## 8. 用户解锁与行为 Tracker

### 8.1 身份

业务身份使用：

```text
PlatformRequestContext.v1.actor.userId
```

不使用 `sessionId` 作为游标或分子键。同一账号多设备读取同一服务端进度，
不同用户在同一项目中保持独立进度。

### 8.2 25% 分子和分母

分母：

```text
original_batch_size
```

分母在批次创建时冻结。归档、他人 Opportunity、网站后续状态变化和删除
Opportunity 都不改变分母。

门槛：

```text
required = ceil(original_batch_size * 0.25)
```

示例：

| 原始批次 | 门槛 |
| ---: | ---: |
| 5 | 2 |
| 20 | 5 |
| 26 | 7 |
| 100 | 25 |

分子只统计：

```text
当前 user
AND 当前 batch item
AND Opportunity insert 实际成功
AND canonical domain 唯一
```

以下不计入：

- 已经由其他成员创建的项目 Opportunity；
- 当前用户重复点击但命中已有 Opportunity；
- 归档、浏览、点击、复制、导出；
- 删除后重新创建同一个已计数网站。

已计入事实不因 Opportunity 后续删除而回退，解锁后也不重新上锁。

### 8.3 18 小时

起点是该批次首次对该用户可见的服务端时间：

```text
first_visible_at
```

判断：

```text
database_now >= first_visible_at + interval '18 hours'
```

无需为每个用户启动 Temporal Workflow。GET status 和 `get-more`
命令在事务内重新评估即可；可选后台投影只用于通知，不是权威。

### 8.4 获取更多

达到 25% 或 18 小时只设置 `unlocked`，不自动发布。

用户点击后：

1. 使用 project/context/generation/user advisory lock；
2. 校验当前用户游标、解锁事实和下一批 `AVAILABLE`；
3. 幂等创建下一批 publication；
4. 游标最多前进一个 batch；
5. 写 lifecycle、audit 和 `GET_MORE` action；
6. 返回新的 feed/status；
7. 不执行发现、补池、DataForSEO 或批次重排。

### 8.5 归档

Coding 决策：V2 归档是 `actor-scoped`，只影响当前用户视图。

原因：

- 项目内用户进度已明确要求独立；
- 项目级归档会让一个成员改变其他成员的推荐结果；
- 当前项目级 `archivePool` 会触发代次和补池，无法满足 V2。

首版提供 item archive。若保留“归档本批”按钮，它只能把当前用户当前批次
的 item 批量写为 actor-scoped archive，不推进游标、不改变 canonical batch，
不计入 25%，也不调用供应商。

## 9. Opportunity 事务更新

继续复用当前项目级唯一约束：

```text
(website_project_id, target_site_key)
```

修改 `opportunity.repository.ts` 的接入方式，而不是复制一套 Opportunity：

```text
尝试 INSERT Opportunity
-> INSERT 成功:
     保留现有 opportunity.created lifecycle/audit
     写当前用户 OPPORTUNITY_CREATED action
     更新当前 batch unlock projection
-> ON CONFLICT:
     返回现有 Opportunity
     不写分子 action
     不增加 successful_opportunity_count
```

V2 feed 不以旧 recommendation/inventory 的 `accepted` 状态排除网站。
返回：

```text
existingOpportunity: boolean
opportunityId: string | null
teamAdded: boolean
createdByCurrentUser: boolean
```

加入 Opportunity 不自动归档。

### 9.1 V2 到 Opportunity 的规范桥

不得直接把 `batch_item_id` 塞进现有 `createFromRecommendation` 并绕过其来源校验。
实现应在同一 repository/transaction 中增加显式 V2 分支，例如：

```text
createFromRecommendationFeedItem
-> lock user + batch item + canonical domain
-> validate active user publication entitlement
-> validate item lineage and inventory version/status
-> reuse existing Opportunity insert, cycle, lifecycle and audit writes
-> INSERT success: write OPPORTUNITY_CREATED action
-> project-domain conflict: return existing Opportunity, no numerator action
```

V1 分支继续执行现有 commercial policy/current generation 保护。V2 分支只能跳过
不适用于 release contract 的 V1 policy 判断，不能跳过项目、context、inventory、
prospect、domain、idempotency 或版本检查。

联系方式分支保持现有语义：

- 有合格公开邮箱：绑定现有 contact candidate/evidence 并创建 active contact；
- 没有合格邮箱：允许创建 `contact_review_required` Opportunity；
- 后一种情况不允许 Draft/Send 假定存在收件人，用户后续需要确认联系人或合作路径。

Opportunity 创建事务成功后，V2 feed 和 Opportunities 查询都要失效并重读；
Mail、Links 和 Reports 不做全局 cache reset。

## 10. V2 API

为避免破坏现有 generated client 和 V1 行为，新增 endpoint family：

```text
GET  /api/v1/projects/:websiteProjectKey/backlinks/recommendation-feed
GET  /api/v1/projects/:websiteProjectKey/backlinks/recommendation-feed/status
POST /api/v1/projects/:websiteProjectKey/backlinks/recommendation-feed/get-more
POST /api/v1/projects/:websiteProjectKey/backlinks/recommendation-feed/items/:itemId/archive
POST /api/v1/projects/:websiteProjectKey/backlinks/recommendation-feed/items/:itemId/unarchive
POST /api/v1/projects/:websiteProjectKey/backlinks/recommendation-feed/export
POST /api/v1/projects/:websiteProjectKey/backlinks/recommendation-seeds/generate
POST /api/v1/projects/:websiteProjectKey/backlinks/recommendation-seeds/validate
```

### 10.1 Feed 查询参数

首版允许：

```text
recommendedOnly
category
trafficMin
trafficMax
rankMin
rankMax
spamMin
spamMax
sort
cursor
limit <= 100
domainSearch
```

首版不允许：

```text
minScore
language filter
topic relevance filter
contact status filter
cooperation type filter
DR
DA
link type
```

`category` 只有在样本验收证明分类来源可靠时才在 UI 开启。可靠来源限定为：

- 用户确认分类；
- 已验证 AI 分类；
- 多来源一致的规范分类。

数值筛选时，值为 `null` 的记录不命中范围；未设置范围时仍展示并标记“未知”。

### 10.2 Feed 响应

用户可见字段：

```text
itemId
domain
displayUrl
recommended
recommendationReasons
category or null
metrics:
  targetMarketOrganicTraffic or null
  dataForSeoRank or null
  spamScore or null
  market
  language
  observedAt
contact:
  email or null
  contactPage or null
  outcome
opportunity state
user archive state
releasedAt
```

禁止返回：

```text
internal score
score model payload
fitDecision raw JSON
hidden pool exact count
unreleased domain/count
provider request fingerprint
provider budget detail
refill tier
internal exclusion reasoning
```

Status 只返回当前用户可行动信息：

```text
currentBatchOriginalSize
successfulOpportunityCount
requiredOpportunityCount
unlockAt
unlockReason
canGetMore
nextBatchState: AVAILABLE | PREPARING | NONE
poolState
```

不能通过 status 推算完整隐藏池数量。

### 10.3 查询边界

Feed、筛选、排序、分页和导出 SQL 必须从：

```text
current user publications
JOIN canonical batch items
LEFT JOIN current user archive projection
LEFT JOIN project opportunity
```

开始查询。不得先查完整候选池再在应用层过滤。

## 11. 后端文件与职责

优先新增小型模块，避免继续扩大当前大型 SQL/Runtime 文件。

### 11.1 Domain

新增：

```text
backend/core/src/modules/backlinks/domain/recommendations/
  recommendation-pool-v2-policy.ts
  recommendation-batch-policy.ts
  recommendation-marker-policy.ts
  recommendation-user-unlock-policy.ts
```

职责：

- 批次公式；
- 停止和低产出规则；
- 联系方式终态判断；
- 推荐布尔标记和 reason code；
- 25% 门槛；
- 状态投影。

Domain 层不访问数据库、DataForSEO 或时钟全局变量。时间作为参数传入。

### 11.2 Application

新增：

```text
application/services/
  recommendation-seed-preparation.service.ts
  recommendation-pool-generation-finalizer.service.ts
  recommendation-release-batch.service.ts
  recommendation-user-release.service.ts

application/queries/
  recommendation-feed.query.ts

application/commands/
  recommendation-feed.command.ts
```

职责分离：

- Seed service 扩展现有 Blueprint，不发明第二个发现模型；
- Finalizer 冻结 T、顺序和批次；
- Batch service 安排联系方式并确认终态；
- User release service 管理 publication、cursor 和 unlock；
- Query 只读已发布 entitlement；
- Command 执行 get-more、archive 和幂等更新。

### 11.3 Repository

新增 release/user-action repository，不把新 SQL 继续塞进
`recommendations.command.ts` 或 `local-product-dataforseo-runtime.ts`。

现有大文件只做最小接线：

- `production-runtime.ts` 注册新 service/query/command；
- `local-product-dataforseo-runtime.ts` 把准备后的有效 seeds 交给现有发现；
- `backlink-recommendation-refill.orchestration.ts` 在发现结束后调用 finalizer 和 batch preparation；
- `opportunity.repository.ts` 增加 entitlement-aware V2 接入，并在实际创建成功分支写 V2 action；
- `draft-generation.repository.ts` 读取版本无关的 V2 selection/evidence snapshot，
  不再把旧 v3 score 当成 V2 上下文前提；
- API 注册新 route。

### 11.4 Workflow

继续使用现有推荐 Workflow 和 Contact Enrichment job/crawler/evidence 表，不复制
第二套 crawler 或 queue。V1 和 V2 必须使用不同的 source selection：

- V1 scheduler 保持当前 inventory/policy/qualification 查询；
- V2 scheduler 从具有完整 canonical lineage 的待准备 batch item 取源；
- 两者进入同一个幂等 Contact Enrichment runner；
- V2 不执行依赖旧 `PUBLISHED + eligible + verified email` 的 policy reconciliation。

推荐 Workflow 新阶段：

```text
PREPARE_SEEDS
DISCOVER_ROUND_1
OPTIONAL_DISCOVER_ROUND_2
FINALIZE_GENERATION
PREPARE_CANONICAL_BATCH
WAIT_CONTACT_TERMINAL
MARK_BATCH_AVAILABLE
PREPARE_NEXT_BATCH
```

Workflow activity 必须幂等。Workflow replay、worker restart、API 刷新和前端轮询
不能重复供应商请求、重复批次或重复联系方式任务。

### 11.5 Runtime、后台任务和项目生命周期

以下现有入口必须显式读取并验证 `pool_contract_version`：

```text
production-runtime periodic recommendation recovery scan
project-analysis completion recommendationRefill.ensure callback
recommendation refill reservation and reconciliation
static assessment recovery scheduler
recommendation refill outbox relay
legacy manual refill/archive-and-regenerate command
supersession and orphan recovery
```

对于 V2 generation，以上 V1 入口必须以 `contract_not_applicable` 结束，并证明：

```text
job created = 0
outbox event created = 0
provider reservation created = 0
DataForSEO request created = 0
```

V2 自己的初始两轮发现可以复用现有 provider ledger、lease、artifact 和幂等基础设施，
但由独立的 V2 round policy 驱动，不能复用 V1 的持续低水位补池决策。

项目新 context、归档或删除时：

- 停止旧 context 未开始的 V2 发现和联系方式准备；
- 已在供应商执行中的请求按现有 unknown-charge/settlement 规则收敛；
- 旧 context 的 PREPARING batch 不得转为 AVAILABLE；
- 已发布 publication/action 保留为历史，只读展示按产品策略决定；
- 已创建 Opportunity 及其 Draft/Send/Reply/Placement 历史不回滚；
- 新 V2 facts 表必须被项目删除 adapter 覆盖，或通过已验证的复合 FK cascade 删除。

## 12. 前端更新

### 12.1 API 和状态

新增 V2 feed API/hook。TanStack Query 负责：

- feed 查询；
- status 查询；
- get-more 后失效并重取；
- archive/unarchive 后更新；
- 后端 BUILDING/ENRICHING/PREPARING 状态轮询。

`localStorage` 只能保存非权威的 UI 恢复提示，不能保存用户游标、解锁或已发布批次。
命令仍由前端生成 idempotency key，但服务端必须把 key 与 actor、项目和动作绑定。

Query/cache namespace 必须保持模块隔离：

```text
recommendation-feed -> ["backlinks", project, "recommendation-feed", ...]
opportunities       -> ["backlinks", project, "opportunities", ...]
mail                -> existing mail keys
links               -> existing links keys
reports             -> existing report keys
```

`get-more`、archive/unarchive 只失效 recommendation-feed。创建 Opportunity 后精确
失效 recommendation-feed 和 opportunities；不得用项目级全清空代替依赖声明。

### 12.2 视图

V2 推荐池移除：

- 数值评分；
- 优先级和风险等级的评分化展示；
- `minScore`；
- 内部库存、refill tier 和预算细节；
- “批量查找联系方式”主操作；
- “归档并生成下一轮”；
- 会触发供应商补池的旧刷新操作。

V2 推荐池增加：

- `SaaS 推荐`标记；
- 一到数条推荐理由；
- Traffic、DataForSEO Rank、Spam 的可空展示；
- “联系方式”区域：邮箱、联系页面、终态说明；
- 当前用户 Opportunity 状态和团队已加入状态；
- 服务端筛选、排序、分页；
- 25% 进度、18 小时倒计时和“获取更多”；
- 下一批“准备中”状态；
- actor-scoped 归档和取消归档。

用户界面不展示“隐藏池还有 N 个”。可以显示：

```text
当前批次
已完成机会数 / 获取更多门槛
获取更多可用时间
下一批准备状态
```

### 12.3 生成客户端

新 route 的 operation ID、schema 和错误枚举完成后重新生成客户端。
不得手工长期维护与 OpenAPI 不一致的 TypeScript response 类型。

## 13. 迁移和切换

### Phase 0：重新进入审计

目标：

- 重查 Git、迁移头、当前 diff 和相关测试；
- 确认产品需求文档没有新增冲突；
- 冻结 task card、owned files、provider ceiling 和 stop point。

退出条件：

```text
无未解释的文件所有权冲突
迁移编号可用
V1/V2 contract boundary 被测试锁定
所有 V1 后台 refill/recovery 入口已列出并有 V2 zero-side-effect 方案
V2 到 Opportunity 的 canonical identity/FK 合同已锁定
```

### Phase 1：加法式 Schema 与 Domain Policy

工作：

- 新增 seed、batch、publication、cursor、unlock、action 表；
- 扩展 generation contract；
- 增加 RLS、索引、唯一约束；
- 增加 candidate/recommendation/prospect/inventory/generation/input pin 复合外键；
- 实现纯 Domain policy 和单元测试。

不做：

- 不切换 API；
- 不调用供应商；
- 不改变 V1 可见性。

### Phase 2：种子生成、验证和补充

工作：

- 在现有 readiness gate 前接入 Seed Preparation；
- 支持用户点击生成和任务开始前自动兜底；
- 记录来源、验证、证据和 Blueprint 引用；
- 保持用户输入可编辑和可追溯。

退出条件：

- 关键词和竞争对手均为空的有效项目可以形成可验证 seeds；
- 无法形成可靠 seeds 时返回明确 `INPUT_REQUIRED`，不伪造网站；
- 已有高质量用户输入不会被覆盖。

### Phase 3：发现预算与代次完成

工作：

- 实现第一轮/第二轮独立预算政策；
- 给周期 Worker、project-analysis hook、recovery、reservation、relay 和旧手工命令
  增加 V1/V2 contract guard；
- 第二轮强制新 request fingerprint；
- 实现 100 供应阈值、1,000 硬上限、低产出和路径耗尽停止；
- 冻结 T 和 generation terminal facts。

退出条件：

- 普通测试零真实 provider call；
- 授权测试证明预算不超过 1 USD + 1 USD；
- unknown charge 不进入第二轮；
- `获取更多`路径与 provider 代码无调用边。

### Phase 4：规范批次与联系方式门槛

工作：

- 确定性创建 canonical batches；
- 在 batch PREPARING 前物化完整 recommendation/prospect/inventory lineage；
- 通过 V2 source selection 接入现有 Contact Enrichment runner；
- 执行当前批和下一批联系方式任务；
- 只在全部 terminal 后 AVAILABLE；
- 处理 24 小时 deadline 和 `COMPLETED_PARTIAL`；
- 冻结 release snapshot。

退出条件：

- `retry_scheduled` 批次不可见；
- 无邮箱、联系页、访问失败和重试耗尽都能形成真实终态；
- 关闭页面或重启 worker 不丢任务。

### Phase 5：用户游标、Tracker、归档和 Opportunity

工作：

- 发布首批；
- 25% 和 18 小时解锁；
- 幂等 get-more；
- actor-scoped archive；
- 增加 entitlement-aware V2 Opportunity 事务桥；
- Opportunity 成功分支写 tracker；
- 为 Draft 生成版本无关的 V2 selection/evidence snapshot。

退出条件：

- 同一用户多设备一致；
- 不同用户互不推进；
- 已存在团队 Opportunity 不计当前用户分子；
- 删除 Opportunity 不回退历史分子；
- 归档不计数、不补位、不调用 DataForSEO；
- 无邮箱终态可以创建 `contact_review_required` Opportunity，但不能绕过 Draft/Send
  联系人门槛；
- V2 Opportunity 能继续进入现有 Draft/Send/Reply/Placement/Reports 主链；
- 双击和并发请求最多前进一批。

### Phase 6：Feed、筛选、导出 API

工作：

- 新 V2 route/query；
- 数据库侧过滤、排序、分页和导出；
- 严格 response schema；
- 隐藏池防泄露测试。

退出条件：

- 所有结果来自当前用户 entitlement；
- 筛选覆盖该用户历次已释放批次；
- 不返回 score、hidden count 和 provider internals；
- `limit` 最大 100；
- 导出不能越过发布边界。

### Phase 7：前端切换

工作：

- 新 V2 workspace/API hooks；
- recommendations route 和 query namespace 独立切换，不改 Opportunities、Mail、
  Links、Reports 页面数据源；
- 推荐标记、理由、指标、联系方式、Opportunity 和归档；
- 解锁进度、倒计时、获取更多；
- 移除 V2 的评分和供应商操作。

退出条件：

- 刷新、切换路由和更换设备均从服务端恢复；
- UI 不显示评分；
- UI 不能通过旧按钮触发补池；
- 创建 Opportunity 只精确刷新 feed 和 Opportunities；
- 桌面和移动视口无文本或控件重叠。

### Phase 8：历史兼容和全量迁移

旧数据没有历史“哪个成员看过哪条”的完整事实，不能伪造精确个人历史，
也不能为了迁移绕过 V2 的联系方式终态门槛。

兼容策略：

1. 有活跃 `CONTACT_PENDING` 的旧代次继续由 V1 读路径服务，不提前切换到 V2。
2. 使用现有 Contact Enrichment 和恢复逻辑把待迁移记录收敛为真实终态。
3. 只有存在 terminal snapshot 的旧可见记录才能投影为 `legacy_imported`
   canonical batch item。
4. 授权项目成员首次进入 V2 时，懒创建该 legacy publication。
5. legacy batch 不触发新的 DataForSEO 请求，也不重复释放已见域名。
6. V1 历史 Opportunity、归档和生命周期证据不改写。
7. 如果旧记录无法安全收敛，项目标记为 `MIGRATION_BLOCKED`，迁移期间可以继续
   使用 V1 只读路径，但不得伪造终态，也不得让 V2 读取 `CONTACT_PENDING`。
8. `MIGRATION_BLOCKED` 是必须解决的迁移阻塞项，不是允许长期保留 V1 的完成状态；
   所有可进入 Backlinks 推荐池的未删除项目完成 V2 切换前，不得宣布全量迁移完成。

切换按 generation contract version 进行，不使用一次性全局替换。

Phase 8 退出条件：

```text
所有可进入 Backlinks 推荐池的未删除项目均已绑定 recommendation-pool.v2
AND active V1 generation = 0
AND MIGRATION_BLOCKED project = 0
```

### Phase 9：全量切换、清理和废弃

只有在 V2 稳定、历史投影完成且没有活跃 V1 generation 后：

- 从 V2 前端删除旧 archive/refill 入口；
- 全局停用 V1 recommendation generation、refill、recovery、reservation、
  relay、旧手工命令和供应商请求入口；
- 停止 V1 用户写 API，旧用户读路径不得继续作为任何项目的推荐池主路径；
- 将 V1 历史推荐、库存、Opportunity lineage 和审计事实置于只读兼容状态；
- 保留管理、审计、历史读取和现有下游 lineage 所需代码；
- 另开任务决定是否最终删除旧逻辑和旧字段。

本期不得为了“代码干净”提前删除 V1。

Phase 9 退出条件：

```text
active V1 generation/job/outbox/reservation = 0
AND new V1 recommendation/refill/provider write = 0
AND all recommendation UI/API reads use V2
AND V1 historical facts are read-only
```

## 14. 测试矩阵

### 14.1 Unit

- `T < 25` 全部返回；
- `T >= 25` 使用 `min(100, ceil(T/5))`；
- 5、20、26、100 原始批次的 25% 门槛；
- 两个连续低产出窗口；
- 推荐标记 reason class 组合；
- 所有 Contact terminal code；
- `retry_scheduled` 非终态；
- 数值 `null` 的筛选语义；
- 稳定排序和指纹。

### 14.2 Database Integration

- 新迁移 fresh/upgrade 路径；
- RLS tenant/project/user 隔离；
- canonical domain 唯一；
- canonical batch 稳定；
- V1/V2 数据共存；
- publication entitlement 防隐藏池泄露；
- 用户归档不影响其他用户；
- AVAILABLE item 的 canonical lineage 六个 ID 均非空且复合 FK 一致；
- Opportunity 并发创建只有一个项目记录；
- 只有实际创建者增加分子；
- V2 entitlement、inventory version/status 和项目域名唯一性在同一事务校验；
- 18 小时使用服务端时钟；
- get-more 双击、重试和多设备并发；
- 删除 Opportunity 不重新上锁；
- 新 context 不重复释放历史域名。

### 14.3 Workflow

- 页面关闭后继续；
- worker 重启后恢复；
- Activity 重试不重复 provider request；
- Round 2 request fingerprint 必须变化；
- 1 USD + 1 USD 上限；
- unknown charge 停止；
- contact deadline 后真实收敛；
- next batch one-ahead；
- supersession 终止旧代次且保留历史；
- 旧 context 的 PREPARING batch 不会在 supersession 后变为 AVAILABLE；
- V1 周期扫描、project-analysis hook、reservation、recovery 和旧手工 refill
  面对 V2 generation 均为 zero job/outbox/reservation/provider side effect；
- 项目归档/删除能停止 V2 job，并覆盖所有新增 facts。

### 14.4 API/OpenAPI

- V2 schema 不含 score 和隐藏池字段；
- numeric filter、category、recommended、sort、cursor、limit；
- unauthorized project/user；
- stale context；
- idempotency key 重放和 request hash 冲突；
- export 只导出 entitlement；
- generated client 与 OpenAPI 同步。

### 14.5 Frontend

- 无关键词时自动兜底状态；
- 推荐标记和理由；
- 指标未知状态；
- 邮箱、联系页面和无公开联系方式；
- 团队已加入 Opportunity；
- 25% 进度和 18 小时倒计时；
- 解锁但下一批准备中；
- get-more 后当前设备更新，其他设备刷新后获得同一账号进度；
- 不同用户不自动前进；
- 归档不改变门槛；
- 推荐页命令不会清空 Mail、Links 或 Reports 状态；
- V2 Opportunity 返回推荐页链接时仍能按 recommendation/item identity 定位；
- 无评分、无旧补池按钮；
- 桌面和移动 Playwright 截图。

### 14.6 外链主链回归

使用 fake provider、fake AI 和 fake Gmail 做零成本跨模块合同测试：

```text
V2 released item
-> existing Opportunity
-> Draft request snapshot with V2 evidence
-> Send Intent
-> Reply match
-> Placement
-> Reports / metric projection
```

必须覆盖：

- 有邮箱路径和 `contact_review_required` 路径；
- 无联系人时 Draft/Send 保持阻断且不制造收件人；
- actor archive/get-more 不改变已创建 Opportunity 或下游事实；
- V1 recommendation 到 Opportunity 的原路径完全不变；
- 下游模块不读取用户 cursor 作为业务状态权威。

### 14.7 成本和真实供应商

普通 CI、单元、集成和前端测试必须使用持久化 fixture/fake adapter，真实成本为 0。

真实 DataForSEO 验收必须另行授权，并分别记录：

```text
request fingerprint
endpoint
location/language
provider task/request ID
estimated and actual cost
usage ledger settlement
raw count
normalized count
new unique count
duplicate count
terminal status
```

## 15. 可观测性

后台和日志必须能按 project/context/generation 查询：

- 当前发现轮次和已用预算；
- 每条发现路径的原始、新增和重复数；
- 低产出窗口；
- 候选、指标和联系方式进度；
- canonical batch 状态；
- 每个用户的 publication/cursor/unlock；
- Opportunity 分子来源；
- archive/get-more 幂等结果；
- provider `unknown_charge`；
- V1 contract guard 的 `contract_not_applicable` 和 zero-side-effect 计数；
- Workflow、job、outbox 和 lifecycle lineage。

面向用户只投影产品状态，不暴露隐藏池或供应商内部信息。

## 16. 回滚策略

回滚的业务安全状态是停止新的 V2 写入并进入维护或只读模式，不是重新启用
V1 推荐池。回滚不得删除历史数据，也不得把任何项目重新绑定到 V1 生成链路。

```text
停止创建新的 V2 generation
-> recommendation-feed 进入维护或只读状态
-> 保留已创建 V2 batch/publication/action
-> 修复并验证后恢复 V2 生成和发布
```

禁止：

- 重新启用 V1 recommendation generation、refill 或供应商请求；
- 把前端推荐池读路径切回 V1；
- destructive down migration；
- 删除用户已释放记录；
- 把 V2 publication 反写成旧 PUBLISHED 伪造兼容；
- 清空 Opportunity 或审计事实；
- 通过脚本手工推进用户游标。

## 17. 实施任务模板

每个阶段必须单独开 Coding task：

```text
Task ID
selected phase
repository / branch / HEAD
current dirty files
owned files
prohibited files
migration ownership
provider/AI/Browser call ceiling
required unit/integration/runtime checks
result document path
exit criterion
stop condition
```

任何阶段发现本文件与当时当前代码冲突时，先更新兼容性审计和方案，
不得静默选择一种实现。

## 18. 完成定义

必须分开报告：

```text
IMPLEMENTED
TESTED
LOCAL_RUNTIME
REAL_PROVIDER
SAMPLE_ACCEPTANCE
DEPLOYMENT
HUMAN_UAT
```

本 Coding 文档完成不代表以上任何实现层级完成。

推荐池 V2 可以进入开发的最低文档条件：

- V1/V2 contract boundary 明确；
- 阻断级冲突均有加法式解决方案；
- 没有第二套 provider、queue、crawler、Opportunity 或 project authority；
- 所有可进入 Backlinks 推荐池的未删除项目均已完成 V2 迁移；
- `active V1 generation = 0` 且 `MIGRATION_BLOCKED project = 0`；
- V1 不再产生 recommendation、refill、job、outbox、reservation 或供应商请求；
- V1 历史事实只读保留，旧代码和旧字段的物理删除可以另开清理任务；
- 所有 V1 后台补池入口对 V2 都有可测试的 zero-side-effect contract guard；
- V2 batch item 到现有 Opportunity 的 canonical lineage、entitlement 和事务边界明确；
- Draft/Send/Reply/Placement/Reports 保持原主链，且无邮箱不会绕过联系人门槛；
- 项目 context supersession、归档和删除已覆盖 V2 jobs/facts；
- 推荐页 route/query cache 更新不会重置其他外链页面的权威状态；
- 用户身份、批次、归档和 Opportunity 计数语义无歧义；
- 数据模型、API、Workflow、前端和迁移顺序可逐阶段验证；
- 真实供应商成本保持显式授权。

## 19. 当前仍需在实施时复核但不阻塞 Coding 的参数

以下不是架构空白，不需要暂停本文档，但实施任务开始时必须重新确认：

1. DataForSEO 当时有效的 endpoint、字段、分页和账号实时价格。
2. `category` 数据可靠性是否达到前端开放筛选器的样本门槛。
3. `24h` 批次联系方式准备截止时间是否需要根据生产样本调整。
4. 低产出默认值 `<5 AND <5%` 是否需要按真实供应商返回分布调整。
5. 推荐理由模板的最终中英文文案。
6. 初始 2 USD 隐藏池耗尽后的长期商业补池方案；本期仍禁止自动付费补池。

这些参数必须版本化、可配置并只影响新代次，不能改写已经释放的历史。

## 20. 2026-08-28 Coding Re-entry Audit

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-FULL-IMPLEMENTATION-001`

本节记录实施开始时对本文档假设的重新核对。详细逐阶段证据记录在
`docs/execution/backlinks-recommendation-pool-v2-full-implementation-001.md`。

### 20.1 已确认仍成立

- 唯一 Coding 根目录是 `C:\Users\DELL\Documents\缝合\john3947-seo-main`。
- Git 分支仍为 `main`，HEAD 仍为
  `7df8d48d088328bd79fb0a1afef364b17cc8b6af`。
- 当前 Backlinks SQL migration 文件头为 `0079`，下一个可用编号为 `0080`。
- 现有 canonical Opportunity、Contact Enrichment、Workflow、provider ledger 和
  project authority 仍可复用；本任务不建立第二套对应系统。
- 当前本地数据库的活跃 V1 refill job 和待处理 V1 refill outbox 都是 `0`。

### 20.2 与目标状态的当前差异

- 当前本地数据库有 `7` 个未删除且最新状态为 active 的项目，但没有 V2 release、
  publication、cursor、unlock 或 action 表。
- 当前共有 `13` 条 generation contract，尚无
  `pool_contract_version='recommendation-pool.v2'` 的可用绑定。
- 当前没有 V2 canonical batch item，因此 V2 到 Opportunity 的 entitlement-aware
  事务桥尚不存在。
- 当前 recommendation route、generated client 和前端 workspace 仍以 V1
  recommendation/inventory 可见性为主。
- 工作区已有大量与本任务开始前就存在的未提交修改；实施必须使用加法式文件和
  最小接线，不能回滚、覆盖或格式化这些修改。

### 20.3 Coding 决策

- 使用 `0080` 建立 V2 加法式 Schema、RLS、复合外键和不可变/幂等约束。
- 使用后续连续迁移完成 V2 项目绑定、真实 terminal legacy projection 和 V1
  新写入冻结；不修改 V1 历史记录来伪造 V2 lineage。
- V1 入口统一通过 generation/project pool contract guard；面对 V2 返回
  `contract_not_applicable`，在任何 job、outbox、reservation 或 provider write
  之前退出。
- V2 feed 只从 user publication entitlement 查询；V2 Opportunity 使用
  `createFromRecommendationFeedItem` 显式分支接入现有 canonical Opportunity。
- 本任务所有自动测试使用 fixture/fake adapter。真实 DataForSEO、AI、Browser、
  Gmail 和其他付费供应商调用上限均为 `0`。

### 20.4 Schema 冲突复核与解决

Phase 0 对当前 SQL Schema 的复核发现四处需要显式落地的差异，按以下方式处理：

- `backlink_commercial_candidates` 增加包含
  `project_context_version_id` 的 scope/context 复合唯一键，使 V2 item 能建立
  context-consistent candidate 外键。
- `backlink_generation_input_pins.project_context_version` 是整数，而推荐 lineage 的
  context identity 是 UUID。`backlink_recommendation_generation_contracts` 作为两者
  的唯一桥梁；不建立不安全的整数到 UUID 直接外键。
- generation contract 的 V2 completion 字段允许一次性从空值写入终态，除此之外
  继续不可变；V1 contract 的 UPDATE/DELETE 不可变约束保持不变。
- native V2 batch item 的六个 lineage ID 必须全部非空。仅
  `legacy_imported=true` 的受控迁移记录可以使用受限 nullable shape；batch 转为
  `AVAILABLE` 时必须由数据库校验 native item 的完整 lineage。

项目删除仍沿用当前 retained-dependency/RESTRICT 语义，不伪造 cascade 删除能力。
用户级 publication、cursor、unlock 和 archive 隔离由 repository 的 actor 条件与
唯一约束共同保证；当前事务没有 `app.current_user_id`，因此不把用户隔离错误地宣称
为 RLS 自动完成。

### 20.5 API 与前端缓存兼容决策

- 现有前端使用仓库自有 `project-query`，不是 TanStack Query。V2 保留现有缓存
  基础设施，并使用独立的 `recommendation-feed` namespace 实现同等的精确失效。
- canonical Opportunity POST 保持同一路径，body 扩展为互斥联合契约：
  `recommendationId` 或 `recommendationFeedItemId`。V1 调用和响应保持兼容；
  V2 分支执行 entitlement-aware 创建，并返回团队已存在/当前用户实际创建事实。
- V2 get-more、archive 和 unarchive 只更新 recommendation-feed cache；创建
  Opportunity 只更新 recommendation-feed 与 opportunities cache，不清空 Mail、
  Links 或 Reports。
