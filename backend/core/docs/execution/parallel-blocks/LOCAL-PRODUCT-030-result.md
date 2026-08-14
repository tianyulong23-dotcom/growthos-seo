# LOCAL-PRODUCT-030 外链适合度、联系人门槛与合同统一结果

- 执行日期：`2026-08-10`（星期一）
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-030`
- 最终状态：`PASS`
- Stop boundary：未执行 `LOCAL-PRODUCT-031..033`

## 1. 结论

现有商业推荐评分已新增
`recommendation-commercial-fit.v3`，历史 v2 评分未删除或覆盖。v3 明确分离
`fitDecision` 和 `contactDecision`，并在数据库、Core、FastAPI、OpenAPI、
generated client 和前端使用同一组字段。

只有 `fitDecision=eligible` 且 `contactDecision=eligible`、存在合格公开邮箱和
完整联系人证据的网站才允许进入 `PUBLISHED`。广告页、投稿页、合作页或邮箱只会
影响合作与联系判断，不能补偿零相关性、无关行业、PBN/Link Farm、不安全网站或
禁止的市场错配。

本轮沿用现有 FastAPI Gateway、私有 Backlinks Core、PostgreSQL、Temporal、
单一 Worker、现有 DataForSEO Provider 和现有队列，没有创建第二套 Provider、
Queue、Worker、Crawler、Browser Launcher、数据库或业务状态机。

## 2. v3 外链适合度

### 2.1 评分组件

v3 使用 100 分制和以下固定组件：

| 组件 | 权重 |
| --- | ---: |
| 产品、主题、关键词和目标页面语义相关性 | 30 |
| 受众与合作场景 | 15 |
| 国家、市场和语言层级 | 15 |
| 网站类型、编辑质量和商业可行性 | 15 |
| DataForSEO Rank、Backlinks、Referring Domains 和垃圾风险 | 15 |
| DataForSEO 流量可见度 | 5 |
| SafeFetch 技术可访问性 | 5 |

每个组件保留原始值、归一化值、权重、得分、证据引用、采集时间和规则版本。
DataForSEO 不可用、SafeFetch 证据不足或需要人工复核时不会伪造零值。

### 2.2 硬门槛

以下任一确定命中时，`fitDecision` 不得为 `eligible`：

- 当前项目自身或关联域名；
- 已有 Backlink 或 Opportunity；
- 永久拒绝或抑制；
- 主题相关性为零；
- 明确无关行业；
- 不安全、恶意或禁止行业；
- PBN 或高置信 Link Farm；
- 当前层级不允许的市场错配。

相同语言的扩展市场使用独立的
`same_language_expansion` 层级和理由码，不会显示为目标国家匹配。

### 2.3 项目语义修正

- 产品、主题、关键词、目标页面路径、目标受众和合作目标均来自当前 Website
  Project。
- 目标页面按 URL path 的语义词匹配，同时在证据中保留原始 URL。
- `pool`、`product`、`products` 等过度通用词不能单独构成高适合度。
- Aiper 场景中，仅出现通用词 `pool` 的无关娱乐或新闻网站会得到零有效相关性，
  并命中相关性/无关行业门槛。

## 3. 联系人与发布门槛

`contactDecision` 与适合度独立保存。合格联系人继续要求：

- 公开来源 URL；
- 联系人证据快照；
- 邮箱用途判断；
- 置信度；
- 邮箱哈希和受控引用；
- 采集时间和联系人规则版本。

仅发现表单、登录墙、验证码、拒绝访问或没有邮箱时，保存明确的不可联系原因，
不会把“可访问合作页”误判为“已有公开邮箱”。

迁移 `0054_backlink_recommendation_fit_contact_contract.sql` 已在现有 PostgreSQL
实例应用。数据库 `PUBLISHED` 约束要求同时满足：

```text
fit_decision=eligible
fit_score_model_version=recommendation-commercial-fit.v3
contact_decision=eligible
contact_reason_code=PUBLIC_EMAIL_FOUND
verified_public_email_count>=1
联系人证据、默认联系人、来源 URL、邮箱引用和规则版本完整
```

迁移将历史库存安全降级为未发布、待 v3 重新评估状态，不会让旧 v2 行绕过新门槛。

## 4. 合同与前端

- Core 推荐 DTO 和查询返回独立的 `fitDecision`、`contactDecision`、总分、七个
  组件、证据、理由和市场层级。
- FastAPI Gateway、共享 OpenAPI、Backlinks OpenAPI 和 generated clients 已
  同步。
- 新版推荐不再映射到旧评分组件或 `legacy_snapshot`。
- 历史 v2 Opportunity/推荐数据仍可通过只读兼容路径查看。
- 前端显示综合适合度、匹配层级、产品/主题/关键词、市场与语言判断、合作角度、
  DataForSEO 权威/流量/风险、相关内容页和联系人证据来源。
- 新版评分缺失时不会用“待补”或旧快照冒充 v3 结果。

## 5. 验收映射

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| `relevance=0` 不能进入 `PUBLISHED` | PASS | v3 `zero_topic_relevance` 硬门槛、发布服务双 Decision 校验、数据库约束 |
| Aiper 不因通用词 `pool` 得到高适合度 | PASS | 通用词过滤和无关行业定向测试 |
| 前端不显示新版“待补”或 `legacy_snapshot` | PASS | 推荐 source 测试和 v3 前端字段映射 |
| API 与前端总分、组件、证据和理由一致 | PASS | Core route、OpenAPI、generated client、前端类型和 source 测试 |
| v2 只读保留，新增评分使用 v3 | PASS | 数据库保留 236 条 v2 Candidate；新发布约束只接受 v3 |
| 只有适合且有公开联系人才能发布 | PASS | publication service 测试和 PostgreSQL CHECK 约束 |
| 同语言扩展市场明确标注 | PASS | `same_language_expansion` 层级和理由码 |

## 6. 验证

### 6.1 Backlinks Core

```text
Vitest targeted: 10 files passed, 44 tests passed
npm run typecheck: PASS
targeted ESLint: PASS
npm run build: PASS
npm run openapi:backlinks:check: PASS, 70 paths
npm run migration:backlinks:check: PASS, 47 files through 0054
git diff --check: PASS
```

定向测试覆盖静态语义评估、v3 评分、候选评估、零相关性硬门槛、发布双门槛、
发现服务、DataForSEO Runtime、库存、Recommendation/Opportunity 路由和本地
产品进程脚本。

### 6.2 FastAPI 与共享合同

```text
pytest targeted: 29 passed
shared contract check: PASS, 90 public paths / 96 operations
```

覆盖数据库迁移系统、共享合同和 Backlinks Gateway。

### 6.3 Frontend 与 generated client

```text
Backlinks generated client: PASS, 71 operations
Platform generated client: PASS, 6 operations
npm run typecheck: PASS
npm run build: PASS
recommendations source tests: 2 passed
```

未执行 `LOCAL-PRODUCT-033` 才允许执行的全量 Backlinks Gate。

## 7. 运行态与数据库证据

`2026-08-10 12:11:17 +08:00` 最终状态：

```text
status=ok
runtimeMode=LOCAL_PRODUCT
runId=20260810-121027
projectKey=elephtv
Frontend HTTP=200
FastAPI HTTP=200
Private Core HTTP=200
PostgreSQL 18=healthy
Backlinks migration head=0054
Temporal=healthy
Temporal namespace ready=true
Core API running=true
Worker running=true
recentErrors=[]
```

Gateway 最终只读请求返回 `HTTP 200`：

```json
{"items":[],"nextCursor":null,"hasMore":false}
```

数据库最终只读核对：

```text
全部历史库存行=181
PUBLISHED=0
fit_decision eligible=0
contact_decision eligible=0
历史 commercial candidate:
  recommendation-commercial-fit.v2=236
```

当前没有触发 v3 真实补货，因此没有伪造 v3 生产记录。历史 v2 数据仍存在，但
0054 后不能继续作为 `PUBLISHED` 返回；后续真实发现必须通过 v3 重新评估。

## 8. Provider 安全

本轮没有新增真实 DataForSEO 或 AI 调用：

```text
Provider Request count=87
latest Provider Request=2026-08-10 01:10:27.160676 UTC
DATAFORSEO_MAX_PAID_CALLS=250
DataForSEO budget limit=1,000,000 micros
spent=974,052 micros
reserved=0
remaining=25,948 micros
AI enabled=false
Browser enabled=false
```

Provider Request 数量、最新时间和预算 Ledger 与执行前一致。未修改预算上限、
历史 Ledger、Kill Switch 或人工确认发送边界。

## 9. 停止

`LOCAL-PRODUCT-030` 已完成并写入本 Result。未执行
`LOCAL-PRODUCT-031..033`，未 commit，未 push。当前 HEAD 仍为
`d796989207cd7dfdec4c0a3fdbc46f855bf0fff9`。
