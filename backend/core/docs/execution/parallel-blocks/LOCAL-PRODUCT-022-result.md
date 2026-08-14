# LOCAL-PRODUCT-022 本地真实产品与 SaaS 隔离最终 Gate

- 执行日期：`2026-08-07`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-022`
- 最终状态：`PASS_CODE_PROVIDER_INPUT_REQUIRED`
- Branch：`外链part`
- Baseline HEAD：`d796989207cd7dfdec4c0a3fdbc46f855bf0fff9`
- Stop boundary：未执行 `QUALITY-BACKLOG-001`

## 1. 结论

日常本地产品主链已经贯通并通过集中 Gate：

```text
Frontend -> FastAPI Gateway -> private Core -> PostgreSQL 18
         -> Temporal Worker -> gated Provider Adapter
```

统一 Start/Stop/Restart/Status 可管理 Frontend、FastAPI、private Core API、Core Worker、PostgreSQL 18、
Temporal 和按需 Browser Worker。默认启动不调用 DataForSEO、AI、Gmail Send 或 Gmail Sync；缺少或关闭
可选 Provider 时，现有 Recommendation、Contact、Opportunity、Draft、Profile、Inventory 和 Monitor
事实仍可读取，其他项目和模块不被阻塞。

代码、数据库、公开 API、前端、Temporal、RLS、多租户矩阵、重启恢复和真实 SafeFetch 直接验证已经完成。
但当前 DataForSEO 预算剩余 `17,200 micros`，低于一次受控候选/Profile 调用的预计
`27,600 micros`；AI capability 关闭且本轮未执行真实模型调用。Gmail 已有一个可用 Organization
Connection，但真实发送、回复和 Polling 事实仍为 `0`，需要用户批准、最终发送和真实收件端回复。

因此不能标记 `PASS_LOCAL_PRODUCT_COMPLETE`。按最终 Gate 的优先阻塞分类，本轮为
`PASS_CODE_PROVIDER_INPUT_REQUIRED`，并同时保留 Gmail 人工动作 Acceptance Debt。

## 2. 022 直接修复

集中 Gate 发现并修复了以下实际缺陷：

1. 商业页面静态评估不再由 Domain 层直接依赖 Cheerio；新增窄
   `CommercialPageParser` Port 和生产 Adapter。
2. Commercial Blueprint/Source 的 Domain Schema 去除 Zod 运行时依赖，保持严格确定性解析。
3. Backlinks private API 操作清单同步到当前 `71` 个 private operations。
4. 新增 `0052_backlink_recommendation_publication_default.sql`，将历史不兼容默认值修复为
   `CONTACT_PENDING`，使 PostgreSQL 18 clean install 可从 `0008` 连续安装到 `0052`。
5. PG18 验证器修复容器 readiness 检查、迁移范围和 98 张 Backlinks 表的契约分组。
6. Opportunities 顶部四个筛选器增加可访问名称，真实键盘/a11y Gate 不再出现严重违规。
7. 修复数个 Integration fixture，使测试数据符合当前 Contact、Opportunity、Quota 和 Sequence 约束。
8. 新增显式 `2 Organization x 2 Workspace x 2 Website Project` 隔离矩阵测试。
9. 新增 Gmail Connection 复用测试：同 Organization 多项目复用一个 Connection 且不复制 Token；
   不同 Organization 即使 Google Subject 相同也生成独立 Connection 和 Secret Reference。

0052 checksum：

```text
517e3dfd9659a4c00375959109d3da6980a615635288501625fa17833589b62f
```

## 3. 日常启动与最终运行状态

最终运行 ID：

```text
20260807-102749
```

`2026-08-07 11:05:34 +08:00` 的 Status：

| 组件 | 状态 |
| --- | --- |
| Frontend `http://localhost:5173` | HTTP 200 |
| FastAPI `http://localhost:7200` | HTTP 200 |
| Private Core `http://127.0.0.1:7301` | HTTP 200 |
| Core Worker | running |
| PostgreSQL | 18.4 / healthy / Backlinks head `0052` |
| Alembic | head `20260806_0009` |
| Temporal | healthy / namespace ready |
| Browser Worker | disabled，按需启动 |
| DataForSEO | disabled |
| AI | disabled |
| Gmail Send / Sync | disabled / disabled |

Status 同时显示 Provider 配置、预算、Kill Switch、Ledger、RLS 和业务队列/事实。当前关键持久化事实：

| 事实 | 数量 |
| --- | ---: |
| Project Context Snapshot | 3 |
| Recommendation / Inventory | 20 / 20 |
| Contact Job / Page / Candidate / Evidence | 18 / 324 / 48 / 145 |
| Verified Contact | 6 |
| Opportunity | 9 |
| Gmail Connection / Connected | 1 / 1 |
| Draft / Version | 3 / 4 |
| SendIntent / SendAttempt / Accepted | 0 / 0 / 0 |
| Mail Cursor / Thread / Message | 0 / 0 / 0 |
| Placement Candidate / Placement | 2 / 1 |
| Monitor Policy / Run / Observation | 1 / 5 / 5 |

默认 Restart 后重新探测现有配置、执行 `0052`、恢复 PostgreSQL/Temporal 事实，没有新增 Provider 调用、
SendIntent、Message 或重复业务记录。日志中的旧 `ClientDisconnect` 来自浏览器取消请求；当前服务
readiness 和后续真实 Gateway 请求正常。

## 4. 真实纵向证据

| 层 | 本轮及 014..021 累积证据 | 结论 |
| --- | --- | --- |
| UI | `localhost:5173` Desktop、390px、键盘项目导航、Recommendation/Opportunity/Links 页面 | PASS |
| FastAPI | 浏览器真实请求到 projects、recommendation-inventory、recommendations、opportunities 均为 HTTP 200 | PASS |
| Core | 公开 Gateway 只调用 private Core；OpenAPI 与 generated client 同步 | PASS |
| PostgreSQL | 98 张 Backlinks 表、RLS、业务事实、预算/Ledger/Kill Switch、重启恢复 | PASS |
| Temporal | 统一 namespace/worker、租户化 Workflow ID、真实 Placement Monitor Run 完成 | PASS |
| DataForSEO | 历史真实 Ledger/Artifact 可审计；本轮预算不足，未新增付费调用 | INPUT_REQUIRED |
| AI | Durable Draft Job、Evidence Snapshot、版本化 Template fallback 可用；本轮无真实模型调用 | INPUT_REQUIRED |
| Gmail | Organization Connection 和多项目授权复用代码完成；本轮无批准、发送或真实回复 | EXTERNAL_ACTION |
| Browser/SafeFetch | Browser 按需且有界；ElephTV 真实公开来源页由 SafeFetch 验证为 `VALID` | PASS |

已经存在的真实 ElephTV 直接验证事实：

```text
inventoryItemId: 6fdfa083-1f8e-57d0-bbb8-3498e0bb32c9
sourceUrl: https://elephtv.africa/
targetUrl: https://elephtv.com/become-an-elephtv-reseller/
directValidationStatus: VALID
monitorRunId: 921522b3-c350-5f00-8de5-cabb794cf469
observationId: e6da3e61-6397-4e90-83f4-bb0660afb70e
temporalRunId: 019fd9c2-1417-7e23-9e8b-5e9849e0f948
```

Recommendation 公开门禁仍由 Core 强制执行：只有 `PUBLISHED` 且至少一个 verified public email 的记录
进入用户可见推荐池；只有表单、受限页面或未命中公开邮箱的 Candidate 保留在未发布库存摘要。
Recommendation 确认后创建 Opportunity，Email 状态与 Opportunity 状态保持分离，AI 无权批准、发送或
改变业务状态。

## 5. SaaS 隔离矩阵

自动化矩阵建立：

```text
2 Organizations x 2 Workspaces x 2 Website Projects = 8 Project Scopes
```

验证结果：

- 每个 Scope 只能读取和更新自己的 Project Context 和 Job；
- foreign Organization/Workspace/Project 读取或更新被 RLS/Repository 约束拒绝；
- 8 个 Workflow ID 均唯一并包含 organization/workspace/project identity；
- 一个指定项目进入预期失败后，其余 7 个项目继续完成，调度器没有全局阻塞；
- Recommendation、Contact、Opportunity、Draft、Send、Mail、Profile、Inventory、Placement 和
  Observation 均沿用同一租户事务/RLS 模型；
- Provider Budget、Kill Switch、Ledger、Rate/Workflow identity 使用租户或项目 Scope；
- 同 Organization 的两个 Project 复用一个 Gmail Connection，未创建第二份 Secret/Token；
- 第二 Organization 使用相同 Google Subject 时得到独立 Connection 和独立 external secret id。

该矩阵是自动化隔离证据，不冒充第二个 Organization 的真实 Google 登录或 Provider 调用。

## 6. 集中验证

| Gate | 结果 |
| --- | --- |
| `npm run verify:backlinks` | PASS |
| Core Unit | `99` files / `523` tests |
| Core API | `30` files / `102` tests |
| Core Contract | `27` files / `171` tests |
| Core Integration | `52` passed files，`4` skipped / `197` passed，`13` skipped |
| Core Security | `9` files / `106` tests |
| Core Resilience | `3` files / `8` tests |
| FastAPI Ruff | PASS |
| FastAPI full pytest | `70 passed, 1 skipped` |
| Frontend Backlinks client | `70` operations valid |
| Frontend Platform client | `6` operations valid |
| Frontend typecheck / lint / build | PASS / PASS / PASS |
| Frontend Outreach source tests | `46/46` |
| PostgreSQL 18 clean install | PASS |
| PostgreSQL existing upgrade | PASS |
| PostgreSQL backup/restore | PASS，RPO `0.374s`，RTO `94.11s` |
| PostgreSQL RLS/database contract | PASS，`98` Backlinks tables |
| Source manifest | PASS，`28` records |
| Dependency allowlist / license | PASS / `693` packages |
| PowerShell local-product scripts | `13/13` |
| `git diff --check` | PASS，仅现有 LF/CRLF warning |

PG18 验证覆盖 clean install、旧库升级、DataForSEO 历史事实兼容、backup/restore 和 RLS。没有清空当前
本地产品 PostgreSQL 或 Temporal。

## 7. 真实 Gateway 浏览器 Gate

浏览器连接的是运行中的真实本地 Gateway，没有使用 API fixture：

| 场景 | 结果 |
| --- | --- |
| Desktop `1440x1000` | PASS，无页面横向溢出，无 console error，Axe serious/critical `0` |
| Mobile `390x844` | PASS，无页面横向溢出，无 console error，Axe serious/critical `0` |
| Keyboard/a11y | `25` 次 Tab 后进入项目 Tabs，ArrowRight + Enter 打开 Opportunities；严重违规 `0` |
| 真实 API | projects、recommendation-inventory、recommendations、opportunities 均 HTTP 200 |

截图：

```text
frontend/output/playwright/local-product-022-desktop-1440.png
frontend/output/playwright/local-product-022-mobile-390.png
frontend/output/playwright/local-product-022-opportunities-a11y.png
```

产品支持的本地 Origin 是 `http://localhost:5173`。使用 `127.0.0.1:5173` 会因严格 CORS Origin 不匹配
而被拒绝，这不是正式本地入口。

## 8. 静态扫描

集中扫描未发现：

- handwritten Outreach Backlinks client；
- production mock/fixture fallback 或 `example.invalid` 业务降级；
- 跨项目前端缓存；
- `LOCAL_PRODUCT_WEBSITE_PROJECT_ID` 决定生产扫描范围；
- Gmail Token 在 Project 之间复制；
- 第二套业务 Queue/Worker/数据库权威；
- 无上限 Provider、Browser、Gmail 或前端轮询；
- Secret、Token、Authorization Code、PKCE verifier、Client Secret 或 API Key 写入结果/日志。

命中的循环均有明确上限或停止条件：SafeFetch 最多 5 次 redirect；Gmail Polling 通过 durable
`continueAsNew` 和 timer 驱动；项目游标检测重复 cursor；前端 active polling 最多 60 秒。

## 9. Acceptance Debt 与恢复边界

### Provider 输入

当前 DataForSEO：

```text
budget limit: 100000 micros
spent: 82800 micros
remaining: 17200 micros
estimated controlled call: 27600 micros
minimum additional budget needed: 10400 micros
```

要关闭 DataForSEO 债务，需要补足或重置预算，然后通过现有 Start 参数在一次有界验收中启用；仍必须
经过 allowlist、Kill Switch、reservation、Ledger、幂等和最大调用次数门禁。

AI 需要在本地 Secret Store 中存在有效 AI Secret Reference，并在受控验收期间显式启用。若仍不提供，
产品继续使用带明确 `TEMPLATE_FALLBACK` 标记的确定性合作模板，不伪装成真实 AI 成功。

### Gmail 人工动作

关闭 Gmail 债务需要用户完成：

1. 如 Google 要求，完成登录、2FA、Consent，并保证授权回调为
   `http://localhost:7200/api/v1/backlinks/gmail-connections/callback`；
2. 在 Draft 页面检查/编辑并人工批准；
3. 勾选最终发送确认，最多发送一封受控真实邮件；
4. 由用户控制的收件端真实回复；
5. 验证 Polling 写入唯一 Message/Thread，并匹配正确 Opportunity/Website Project。

这些动作不应通过手工 SQL 或命令行伪造业务状态。发送 unknown outcome 时不得自动重发，必须先按
Message-ID/provider 状态恢复。

## 10. 最终边界

本轮未执行新的付费 DataForSEO 调用、真实 AI 调用、Gmail 发送或 Gmail Sync；未 commit、未 push，
未执行 `QUALITY-BACKLOG-001`。本地产品服务保持运行，可从以下入口继续使用：

```text
http://localhost:5173
```
