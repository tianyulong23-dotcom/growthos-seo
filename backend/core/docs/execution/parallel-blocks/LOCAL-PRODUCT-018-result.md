# LOCAL-PRODUCT-018 可配置的 AI 个性化开发信草稿

- 执行日期：`2026-08-06`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-018`
- 最终状态：`PASS_CODE_PROVIDER_INPUT_REQUIRED`
- Branch：`外链part`
- Baseline HEAD：`d796989207cd7dfdec4c0a3fdbc46f855bf0fff9`
- 最终本地运行 ID：`20260806-224119`
- Stop boundary：未执行 `LOCAL-PRODUCT-019`

## 1. 结论

Opportunity 到草稿的真实本地链路现已支持可配置 Draft Request、不可变 Evidence/Request Snapshot、
durable Draft Job、45 秒 AI Provider 边界、一次 Schema Repair、一次 Provider Retry、明确标记的
版本化模板 fallback，以及可恢复的前端轮询状态。

AWOL Vision 已使用真实 Opportunity、确认联系人和项目推广目标完成两组运行验收：

- 默认 `GENERAL_PARTNERSHIP + NOT_SPECIFIED` 草稿；
- `CONTENT_PARTNERSHIP + DOFOLLOW_PREFERRED` 草稿；
- 两封草稿均提及 `awolvision.com`、`valerion.com` 和真实产品/业务上下文；
- 正文分别为 `141` 和 `170` 个英文词，均为 `4` 个短段落；
- dofollow 只表达为可被拒绝的偏好和询问，没有承诺；
- AI Provider 未启用时均进入 `SUCCEEDED + TEMPLATE_FALLBACK`，没有无限 RUNNING；
- AI 只创建 Draft Version，没有 approve、send 或改变 Opportunity 状态。

本机没有可用 AI Provider Secret Reference，因此没有伪造真实 AI Canary，最终状态按任务要求记录为
`PASS_CODE_PROVIDER_INPUT_REQUIRED`。

## 2. Draft Request 与输入 UI

前后端统一支持以下字段并由 Zod、OpenAPI 和 generated client 约束：

- cooperationType；
- linkAttributePreference；
- promotionTargetUrl；
- anchorTextSuggestion；
- language、tone、subjectStyle；
- additionalRequirements、forbiddenPhrases。

用户未填写时恢复：

```text
GENERAL_PARTNERSHIP
NOT_SPECIFIED
项目默认推广目标页
项目默认语言
NEUTRAL_BUSINESS
CLEAR_DIRECT
```

Request 在创建 Job 时写入 `backlink_draft_request_snapshots`。Snapshot 记录 Opportunity、Contact、
Contact Version、逻辑草稿键和完整请求 JSON；表启用 RLS，并使用不可变触发器禁止更新或删除。刷新、
离开返回和重新生成均从服务端 Job/Request Snapshot 恢复，不依赖浏览器本地缓存作为业务真相。

## 3. Evidence、Prompt 和输出安全

Evidence Snapshot 由 Core 组装并包含：

- 用户网站名称、Domain、产品、目标市场、关键词和推广目标页；
- 目标网站、当前 Opportunity、确认 Contact 和公开联系人证据；
- 当前用户输入事实；
- 事实来源、可见性、状态和置信度。

具体陈述只允许使用 `ACTIVE + VISIBLE`、达到置信度门槛且非 `AI_INFERENCE` 的事实。Prompt
继续复用 Core PromptBuilder、Vercel AI SDK 和 Zod，结构为 base policy、cooperation module、
Evidence Snapshot、用户要求和输出 schema，没有引入 Agent Framework 或第二套草稿系统。

输出固定包含：

```text
subject
body
factsUsed
riskFlags
canAutoSend=false
```

Prompt Injection、虚构流量/排名/合作历史、未替换占位符、排名或发布承诺均由 policy、Fact Gate、
结构化输出校验和 deterministic fallback 共同限制。

## 4. 性能、重试和终态

- 创建 Draft Job API 的真实 AWOL 重新生成请求在 `131 ms` 返回 `202`；
- AI Provider timeout 固定为 `45000 ms`；
- Workflow 保存 `QUEUED`、`RUNNING`、`RETRY_SCHEDULED`、`SUCCEEDED`、`FAILED`、`REFUSED`；
- Schema 错误只允许一次 Repair；
- Provider 错误只允许一次受控 Retry；
- 失败后进入明确终态或 `TEMPLATE_FALLBACK`，不无限 RUNNING；
- 前端最多活跃轮询 `60` 秒，超时后停止轮询，重进时读取同一 Job；
- Temporal Activity 外层 envelope 为 `4` 分钟且 `maximumAttempts=1`，业务重试只由 Workflow 记录和控制。

自动化测试覆盖 AI timeout、Schema 错误、Provider 失败、Retry、fallback 和终态持久化。真实本地运行
因 `AI_PROVIDER_ENABLED=false` 使用 deterministic fallback，未冒充 MODEL 成功。

## 5. AWOL 真实运行证据

真实对象：

| 对象 | 值 |
| --- | --- |
| Website Project | `AWOL Vision / awolvision.com` |
| Opportunity | `59c7acf6-4988-4d46-89e3-09b1f5c9ad64` |
| Target Website | `valerion.com` |
| Confirmed Contact | `support@valerion.com` |
| Promotion Target | `https://awolvision.com/` |
| Product | `Home cinema projector` |

默认草稿：

| 字段 | 结果 |
| --- | --- |
| Job | `699755d4-b675-4cf6-b443-9f041dd0e677` |
| Draft | `a24796ed-c7e5-41f1-b0b8-9a55bd78c6e0` |
| Request Snapshot | `1507cead-247d-4dde-9a10-1be0ddac434a` |
| Draft Version | `bde3e252-3781-4f34-9822-5987c09c8cfa` |
| Terminal State | `SUCCEEDED` |
| Generator | `TEMPLATE_FALLBACK` |
| Length | `141` words / `4` paragraphs |

DOFOLLOW_PREFERRED 草稿：

| 字段 | 结果 |
| --- | --- |
| Job | `16930721-ec2a-4883-8e24-104f9ef12963` |
| Draft | `2be69800-86cb-4a54-a4bc-fea8712fe339` |
| Request Snapshot | `65fbc223-ac2b-4822-abef-e00524f9e567` |
| Draft Version | `c30e6c1a-08b6-41f7-9d11-9cd17abadcb1` |
| Terminal State | `SUCCEEDED` |
| Generator | `TEMPLATE_FALLBACK` |
| Length | `170` words / `4` paragraphs |

正文中的 dofollow 表达为：

```text
If a link is editorially appropriate, we would prefer dofollow, but we will
respect your linking policy and a nofollow placement is also acceptable.
```

它明确允许对方采用 nofollow 或拒绝，不构成 dofollow、发布、收录或排名承诺。

## 6. 版本保留和用户控制

在 DOFOLLOW_PREFERRED 草稿上先保存人工编辑版本，再触发真实重新生成，数据库版本链为：

| Version | Source | Parent | Subject |
| ---: | --- | --- | --- |
| 1 | `TEMPLATE_FALLBACK` | null | `Editorial collaboration with awolvision.com` |
| 2 | `MANUAL` | v1 | `AWOL manual review marker` |
| 3 | `TEMPLATE_FALLBACK` | v2 | `Editorial collaboration with awolvision.com` |

重新生成 Job `1abb148e-6502-431a-b710-24a45314baf1` 在 `198 ms` 后开始，并在 `13 ms`
内完成。人工 v2 仍是独立不可变记录，v3 通过 parent 指向 v2，没有原地覆盖用户编辑。所有版本均为
`requiresUserConfirmation=true`、`canAutoSend=false`。

编辑和批准继续由现有 Draft Aggregate 的 expectedVersion 控制；修改批准正文会产生新版本，旧批准
版本不会自动授权新正文发送。

## 7. 多项目隔离和零发送

当前项目 ID：

```text
ElephTV:     e0bfde33-54bd-454a-ab61-cf7a4a48dcf0
AWOL Vision: 4ec81dca-a0d0-40f3-9ff1-9cdff6613924
```

Draft、Request Snapshot、Evidence Snapshot 和 Model Run 均带 Organization、Workspace 和
Website Project 复合身份与 RLS。真实数据库中 AWOL 有 `3` 个 Draft、`3` 个 Request Snapshot、
`4` 个 Evidence Snapshot 和 `4` 个 Model Run；ElephTV 当前项目有自己的 `3` 个 Draft、
`3` 个 Evidence Snapshot 和 `4` 个 Model Run。项目切换不会把 AWOL Opportunity 或 Contact
带入 ElephTV。

最终发送事实：

| 检查 | 结果 |
| --- | ---: |
| AWOL SendIntent | 0 |
| AWOL SendAttempt | 0 |
| 全库历史 SendIntent | 2 |
| 全库历史 SendAttempt | 2 |
| 本轮新增发送记录 | 0 |

历史两组发送记录不属于本轮。`GMAIL_SEND_ENABLED=false`、`GMAIL_SYNC_ENABLED=false`，本任务没有
调用 Gmail send/sync。

## 8. 前端和真实浏览器

真实 AWOL 页面验证：

- 从 Opportunity 带入 `support@valerion.com`；
- 默认推广目标页为 `https://awolvision.com/`；
- 所有 Draft Request 输入均可见；
- 刷新后仍从服务端恢复联系人、默认值和 Job 查询状态；
- 离开到 Opportunity 列表再返回后状态恢复；
- 切换 ElephTV 后 URL 变为 `/projects/elephtv/backlinks/drafts/new`，AWOL Opportunity 参数被移除；
- 390px 下控件纵向排列，无文本重叠或横向溢出；
- 全新浏览器会话控制台 `0` errors、`0` warnings。

验收截图：

```text
output/playwright/local-product-018-awol-draft-desktop.png
output/playwright/local-product-018-awol-draft-mobile-390.png
output/playwright/local-product-018-elephtv-isolation-desktop.png
```

## 9. 验证证据

| 验证 | 结果 |
| --- | --- |
| Backlinks migration manifest | `41` files through `0048` |
| Migration 0048 PostgreSQL integration | `8/8` |
| Draft API/Workflow/AI targeted tests | `41/41` |
| Local runtime/importer/process tests | `20/20` |
| Core typecheck/build | PASS |
| 018 targeted backend ESLint | PASS |
| PowerShell parser | PASS |
| Backlinks generated client | `62` operations |
| Platform generated client | `6` operations |
| Frontend draft source tests | `8/8` |
| Frontend build | PASS |
| Frontend targeted ESLint | PASS |
| Playwright desktop/refresh/leave-return/project switch | PASS |
| Playwright mobile 390px | PASS |
| Fresh browser console | `0` errors / `0` warnings |

Core 全量 ESLint 仍会命中 015/016 推荐模块中的既有规则问题；018 涉及文件的定向 ESLint 已通过，
本任务未扩大范围修改推荐模块。

Migration `0048_backlink_draft_request_snapshots.sql` checksum：

```text
a62313261d97e9b18caac32539af2649d33f7e04b737d06674ee9ab3cf1b103d
```

## 10. 最终运行状态

| 组件/能力 | 结果 |
| --- | --- |
| Frontend `http://localhost:5173` | HTTP 200 |
| FastAPI `http://localhost:7200` | HTTP 200 |
| Private Core `http://127.0.0.1:7301` | HTTP 200 |
| PostgreSQL 18 | healthy |
| Alembic head | `20260806_0009` |
| Backlinks head | `0048` |
| Temporal | healthy / namespace ready |
| AI Provider | disabled |
| AI timeout | `45000 ms` |
| Gmail Send | disabled |
| Gmail Sync | disabled |

真实 AI Provider Canary 的唯一剩余输入是受保护的 AI Provider Secret Reference。凭证导入器现已允许
并固定最高 `45000 ms` timeout；用户提供凭证后可启用一次受控 Canary。本任务到此停止，未执行
`LOCAL-PRODUCT-019`。
