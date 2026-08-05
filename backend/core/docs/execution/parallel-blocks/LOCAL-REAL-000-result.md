# LOCAL-REAL-000 文档与现场基线结果

- 执行日期：2026-08-04
- 现场审计窗口：2026-08-04 09:50-10:23 Asia/Shanghai
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 任务状态：`PASS_BASELINE_ONLY`
- 本地真实产品状态：`BLOCKED`
- 真实 Provider 本轮状态：`NOT_EXECUTED`
- Git：未 commit、未 push、未撤销用户改动

`PASS_BASELINE_ONLY` 只表示 `LOCAL-REAL-000` 要求的补充协议、现场事实、真实缺口和后续依赖已经形成可审计基线，不表示 `PASS_LOCAL_REAL_PRODUCT`。

## 1. 本轮范围

本轮只执行 `LOCAL-REAL-000`：

1. 读取权威文档、研究/POC、Accepted ADR、版本化 Contract、Migration、自动化测试、Coding State 和历史结果。
2. 审计当前代码、工作树、进程、端口、PostgreSQL、Temporal、Provider 开关和前端数据源。
3. 新建 `GrowthOS-本地真实外链产品验收补充协议-V1.0-2026-08-04.md`。
4. 固化 `LOCAL-REAL-001` 至 `LOCAL-REAL-009` 的模块、共享保护面和最低验收命令。

本轮没有清洗数据、修改状态机、接通 DataForSEO、抓取联系人、修改加入机会门禁、调用 AI/Gmail、同步回复或验证 Placement。

## 2. 权威顺序与适用结论

执行时按用户指定的 1-12 顺序读取。新补充协议只覆盖五项新增验收规则：

- 本地真实运行不等于公网发布。
- Recommendation 可先展示，Contact 可异步补充，以满足 5 分钟至少 10 条可评估推荐。
- 本项目要求前端显示可发送邮箱并完成必要确认后，才允许加入 Opportunity。
- Crawlee 联系人主链描述被 Production Baseline 与 3C 报告覆盖。
- demo/canary/fixture/seed/`.example.invalid` 不得进入真实项目产品 API 或页面。

其余边界继续有效：FastAPI 是唯一公共 Gateway；Fastify Core 私有；PostgreSQL 是业务事实源；Temporal 只编排；Crawler 只返回 evidence；DataForSEO 不拥有业务状态；AI 不决定收件人、批准、发送或推进状态；Gmail 邮件状态与 Opportunity 状态分离。

已确认的 Accepted ADR：

- `ADR-BL-0001-bounded-context.md`
- `ADR-BL-0002-runtime-stack.md`
- `ADR-BL-0003-shared-repository-deployment-topology.md`

当前版本化数据库头：

- Platform/Alembic：`20260724_0007`
- Backlinks：`0036`
- PostgreSQL：`18.4`
- Backlinks 表：`73/73` 启用且强制 RLS

## 3. 修复前失败证据

在创建文档前执行：

```powershell
$required = @(
  'C:\Users\DELL\Documents\缝合\GrowthOS-本地真实外链产品验收补充协议-V1.0-2026-08-04.md',
  'C:\Users\DELL\Documents\缝合\john3947-seo\backend\core\docs\execution\parallel-blocks\LOCAL-REAL-000-result.md'
)
$missing = $required | Where-Object { -not (Test-Path -LiteralPath $_) }
if ($missing.Count -gt 0) {
  Write-Output ('LOCAL_REAL_000_BASELINE_MISSING:' + ($missing -join '|'))
  exit 1
}
```

结果：退出码 `1`，两份必需文档均为 `LOCAL_REAL_000_BASELINE_MISSING`。该证据先于本轮修复产生。

### 修复后验证

| 验证 | 结果 | 证据边界 |
|---|---|---|
| 补充协议/result 断言与 Secret 模式扫描 | `PASS` | 首次严格字面断言退出 `1`；补入无格式干扰的规范性表述后退出 `0`，两份文件 Secret 模式命中 `0` |
| Core `npm run verify:backlinks` | `PASS` | Unit `446/446`、API `96/96`、Contract `165/165`、Integration `179` passed / `13` environment-skipped、Security `102/102`、Resilience `8/8`；typecheck/lint 与 Workflow bundle 同一总门禁退出 `0` |
| FastAPI Ruff / full pytest | `PASS` | 首次错误使用不存在的 `backend/api/.venv`，不能计为测试；改用当前本地产品隔离环境 `C:\Users\DELL\AppData\Local\GrowthOS\live001\python\Scripts\python.exe` 后 Ruff 退出 `0`，pytest `65 passed, 1 skipped` |
| Frontend typecheck / lint / build | `PASS` | 三项退出 `0`；构建保留一个大 chunk 警告，不是本轮基线失败 |
| Frontend targeted source tests | `PASS` | `25/25`，覆盖 Recommendation、Opportunity、Draft、Gmail、Mail、Links 和 Project query isolation |
| Frontend Playwright | `PASS_WITH_TEST_FIXTURES` | 默认 Playwright Chromium 不存在，首次桌面运行退出 `1`；使用配置支持的系统 Chrome 重跑后 desktop `2/2`、mobile `1/1`、keyboard/a11y `1/1` |
| 当前本地运行状态 | `PASS_RUNTIME_HEALTH_ONLY` | 2026-08-04 10:23:09 +08:00：Frontend、FastAPI、private Core HTTP 200，Worker/进程组运行，PostgreSQL/Temporal healthy，六个 listener 均为 loopback |
| 当前公共 API smoke | `BLOCKED_PRODUCT_DATA` | Ready Recommendation `0`；Opportunity `2` 且包含 `.example.invalid`；Links `1` 且包含 `.example.invalid` |

Playwright 使用 `frontend/test/support/outreach-api-fixtures`，因此只计入 `TESTED`，不计入 `REAL_PROVIDER_VERIFIED` 或当前真实项目产品证据。FastAPI 通用复验命令仍以仓库锁文件约定的 `uv run --frozen ...` 为准；本机 PATH 没有 `uv`，本轮使用正式本地产品已安装的隔离 Python 环境完成同一锁定依赖集的现场复验。

## 4. Coding State 与历史结果审计

`backlinks-ai-coding-state.md` 是当前 canonical 状态记录；历史结果保留原文，但不能代替当前现场证据。

| 结果 | 文档状态 | 本轮采用方式 |
|---|---|---|
| PB-A、PB-B、PB-C1、PB-C2、PB-D、PB-E、PB-F、PB-FE-DRAFT、PB-FE-REPORTS | `INTEGRATED` 或等价 | 只证明对应代码/契约曾完成集成 |
| PB-FE-GMAIL | `PASS_DEVELOPMENT_ONLY` | 不证明当前真实 Gmail 产品闭环 |
| PB-FE-LINKS、PB-FE-MAIL | 结果文件仍写 `HANDOFF_READY` | 以 Coding State 的后续集成记录为准；保留历史标题差异 |
| PB-SHARED-DEPS | 混合 `INTEGRATED`/`HANDOFF_READY` | 逐项读取，不整体提升为真实产品证据 |
| PB-G-PHASE-GATES | `PASS_DEVELOPMENT_ONLY` | 不升级为真实 Provider 或产品 PASS |
| PB-LIVE-ACTIVATION | `IN_PROGRESS` | LIVE-005 DataForSEO 未形成当前真实证据 |
| PB-LOCAL-PRODUCT-FINAL | `PASS_LOCAL_PRODUCT` | 属于 2026-08-03 历史本地闭环；其中 fixture/canary 证据不计入本轮真实项目验收 |

结论：历史 AI/Gmail 受控 canary 记录可以作为审计历史，但本轮没有重新打开 Provider、重新发送、重新同步或重新验证，因此 `REAL_PROVIDER_VERIFIED = NOT_EXECUTED`。

## 5. 当前运行现场

`.\Status-GrowthOS-LocalProduct.ps1 -Json` 在 2026-08-04 09:58:29 +08:00 返回 `status=ok`：

| 组件 | 当前事实 |
|---|---|
| React/Vite | `127.0.0.1:5173`, HTTP 200 |
| FastAPI Gateway | `127.0.0.1:7200`, HTTP 200 |
| Private Fastify Core | `127.0.0.1:7301`, HTTP 200 |
| PostgreSQL | 容器 `growthos-live001-postgres`, healthy, `127.0.0.1:55432` |
| Temporal | 容器 `growthos-live001-temporal`, healthy, `127.0.0.1:57233`, metrics `59090` |
| Backlinks Worker | 本地进程组运行，队列配置为 `growthos.backlinks.v1` |
| Temporal namespace | `growthos-backlinks-canary`, ready |
| 运行模式 | `LOCAL_PRODUCT` |
| 当前 Website Project key | `elephtv` |

当前六个监听全部绑定 loopback。浏览器 API base 是 `http://localhost:7200`，没有配置浏览器直连 Core、Crawler、Temporal 或 PostgreSQL。

当前 Docker composition 只有 PostgreSQL 与 Temporal 两个容器。状态脚本没有显示 Go Crawler、对象存储、Redis 或 Browser Worker 正在运行；这些能力不能从“仓库中存在代码”推导为当前产品已接通。

Temporal 当前没有可证明的运行中业务 Workflow。namespace 名称仍带 `canary`，该名称不等于 canary 数据隔离已经完成。

## 6. Provider 现场

运行环境能力层：

| 开关 | 环境值 |
|---|---|
| `DATAFORSEO_ENABLED` | `false` |
| `AI_PROVIDER_ENABLED` | `true` |
| `GMAIL_SEND_ENABLED` | `true` |
| `GMAIL_SYNC_ENABLED` | `true` |
| `BROWSER_PROVIDER_ENABLED` | `false` |

PostgreSQL 最新 Kill Switch 版本全部恢复为阻断：

- `AI_PROVIDER`：version 3, blocked
- `GMAIL_SEND`：version 7, blocked
- `GMAIL_SYNC`：version 9, blocked
- `backlinks.dataforseo.v1`：version 1, blocked
- `BROWSER_PROVIDER`：version 1, blocked

环境变量为 `true` 只表示运行时具备受控 composition，不表示当前允许调用。Core/PostgreSQL Kill Switch 是当前能力判定事实。

当前 ElephTV 项目：

- DataForSEO Provider Request：`0`
- DataForSEO Usage Ledger：`0`
- 本轮真实 DataForSEO/AI/Gmail/Browser 调用：`0`

## 7. 当前项目、API 与数据库事实

Platform Projects：

| ID | 名称 | Domain |
|---|---|---|
| `33333333-3333-4333-8333-333333333333` | ElephTV | `elephtv.com` |
| `33333333-3333-4333-8333-333333333334` | LIVE-002 Isolation Canary | `live002-isolation.example.invalid` |

ElephTV 真实项目 ID 仍包含历史污染：

- Recommendation：`publisher-live002.example.invalid`, status `accepted`
- Recommendation：`qq.com`, status `accepted`
- Recommendation Inventory：`qq.com`, status `accepted`
- Opportunity：`publisher-live002.example.invalid`, `RELATIONSHIP_ACTIVE`
- Opportunity：`qq.com`, `JOINED`
- Placement source：`https://publisher-live002.example.invalid/research/growthos`
- Placement target：`https://live001-canary.example.invalid/growthos/backlinks`
- Contact Candidate：一个 external-domain/general 历史候选；一个 `qq.com` editorial 候选
- Contact：一个 `qq.com` active editorial Contact

公共 Gateway 实际读取：

- `GET .../recommendations?status=ready&limit=100`：HTTP 200，`items=[]`
- `GET .../recommendations?status=accepted&limit=100`：HTTP 400
- `GET .../opportunities`：HTTP 200，返回上述两个污染 Opportunity
- `GET .../links`：HTTP 200，返回上述 `.example.invalid` Placement

所以当前推荐页不是“已有真实推荐”：Ready 为 0；数据库中的两个 accepted 记录也不是可计入本地真实验收的推荐。

## 8. 前端数据来源审计

已确认：

- `frontend/src/api/client.ts` 只使用 `VITE_API_BASE_URL`，当前为公共 Gateway。
- Recommendations 使用 generated client 和公共 `GET /backlinks/recommendations`，没有 Recommendation mock fallback。
- Project query cache 按 Website Project key 隔离并中止跨项目请求。
- 当前 `VITE_WEBSITE_PROJECT_KEY=elephtv`，运行时只投影 ElephTV。

真实缺口：

- `frontend/src/app/project-context.ts` 在缺少本地环境变量时仍回退到四个硬编码项目，真实产品必须改为 Platform Projects API/PostgreSQL 权威。
- `frontend/src/features/outreach/outreach-workspace.tsx` 的“创建 Opportunity”按钮只在任意创建请求进行中禁用；没有 Contact、可发送邮箱、`guessed=false`、置信度或人工确认门禁。
- 前端当前 Ready 推荐数为 0，无法达到 5 分钟至少 10 条真实可评估推荐。
- Opportunities 和 Links 页面会显示当前 ElephTV 项目中的 canary/`.example.invalid` 数据。

## 9. 当前真实缺口

| ID | 缺口 | 后续任务 |
|---|---|---|
| G-001 | ElephTV 项目混有 canary、`.example.invalid`、`qq.com` 和错误 Placement | 001 |
| G-002 | Project Context 仍有静态 fallback，产品运行未完全由 Platform Projects API 权威提供 | 001 |
| G-003 | accepted Recommendation 查询返回 400；Ready 库存为 0 | 001/002 |
| G-004 | DataForSEO 关闭、无请求/费用账本、无真实推荐供应，5 分钟/10 条未验证 | 002 |
| G-005 | 联系人只存在历史受控记录；未证明真实多页面 PageDiscovery、SafeFetch 主链与动态兜底 | 003 |
| G-006 | “加入机会”没有可发送邮箱和必要人工确认门禁 | 004 |
| G-007 | AI/Gmail 虽有历史受控记录，但最新 Kill Switch 已关闭，本轮没有真实 Provider 复验 | 005/006 |
| G-008 | Gmail 当前真实回复同步、唯一匹配、歧义队列和重启游标恢复未在本轮复验 | 006 |
| G-009 | 当前 Placement 是 `.example.invalid`；没有客户原有外链和新获外链的真实直接验证与周期监控 | 007 |
| G-010 | 100 站 Contact Gold Set、200 页 Placement Gold Set 和费用对账未完成 | 008 |
| G-011 | 当前 composition 未显示 Go Crawler/对象存储运行；完整关闭 DataForSEO、逐组件重启恢复与全页无污染未完成 | 009 |

本轮按要求只列出缺口，没有开始修复。

## 10. 后续任务触点与保护面

以下命令是每个任务的最低门禁。真实 Provider、真实网页、受控收件人和重启证据不能被 Unit/fixture 测试替代。

### LOCAL-REAL-001

- 模块：Platform Project authority、FastAPI context/Gateway、Recommendation/Opportunity query/repository、PostgreSQL 数据分类与隔离、frontend Project Context/Recommendations/Opportunities。
- 保护面：`backend/api/**`、`backend/contracts/openapi/**`、`backend/database/**`、`frontend/src/App.tsx`、`frontend/src/app/**`、`frontend/src/api/client.ts`、`frontend/src/features/projects/project-workspace.tsx`、`frontend/src/features/outreach/outreach-workspace.tsx`。
- 验收命令：FastAPI `test_project_authority.py test_authoritative_platform_context.py test_backlinks_gateway.py`；Core recommendations/opportunity API 与 integration suites；frontend `project-query.test.ts`、recommendations/opportunities source tests、typecheck/lint/build；SQL 断言真实 Project 的产品查询不含 `example.invalid`、canary、`qq.com` 污染。

### LOCAL-REAL-002

- 模块：DataForSEO adapter/client/mapper、RequestIntent、budget/cache/artifact/lease/ledger、RecommendationContext、inventory/refill/outbox/Temporal workflow、Recommendations read model。
- 保护面：Provider Port/DTO 边界、`backend/contracts/**`、Backlinks migrations、Temporal registry/queue、Gateway route、generated client。
- 验收命令：DataForSEO unit/contract/cost-control integration、recommendation inventory/refill integration、Core full gate；真实小预算 canary；SQL 对账 Provider request/artifact/usage ledger；刷新页面前后 live call 数不增加；低/高水位与 5 分钟/10 条计时验证。
- `INPUT_REQUIRED`：`DATAFORSEO_CREDENTIAL_SECRET_REF`、允许的 Endpoint、项目预算/调用上限和明确 canary 授权；不得提供或记录明文 login/password。

### LOCAL-REAL-003

- 模块：ContactDiscoveryService、PageDiscovery、SafeFetch、Cheerio parser、validator/tldts、Contact repository/evidence、Temporal enrichment、受控 Playwright/shared crawler evidence、Contact API。
- 保护面：`backend/crawler/**`、`backend/browser-worker/**`、crawler JSON Schema/Event/Temporal registry、FastAPI Gateway、Backlinks OpenAPI、PostgreSQL migrations。
- 验收命令：contact purpose/unit、contact parser/SafeFetch/URL/robots security、contact integration/manual command/API、Temporal worker tests；`go test ./...`；真实域名多页面抓取，核对 evidence、no-contact、unknown purpose 和动态兜底预算。

### LOCAL-REAL-004

- 模块：frontend Recommendations row/contact states/filters/actions、Opportunity create API；Core Contact sendability query 和 Opportunity command guard。
- 保护面：`frontend/src/features/outreach/outreach-workspace.tsx`、`frontend/src/features/projects/project-workspace.tsx`、`frontend/src/App.tsx`、`frontend/src/app/**`、`frontend/src/api/client.ts`、generated client、Backlinks OpenAPI。
- 验收命令：recommendations/opportunities source tests、Core contacts/recommendation/opportunity API 与 command integration、frontend typecheck/lint/build、desktop/mobile/keyboard Playwright；浏览器真实 API 断言无邮箱时按钮禁用，确认后才可加入。

### LOCAL-REAL-005

- 模块：AI draft adapter/runtime/prompt/evidence、Draft workflow/repository/API、Gmail OAuth/send client、SendIntent/policy/workflow/evidence、draft/send frontend。
- 保护面：Secret Store、Provider allowlist/Kill Switch、Gmail scopes、Temporal registry、Gateway/OpenAPI、mail/draft shared frontend composition。
- 验收命令：AI/Gmail contract、draft/send unit/API/integration/security/resilience、Core full gate、frontend draft/Gmail source tests和 Playwright；受控真实 AI canary；用户确认后恰好一次真实 Gmail send；重启后草稿/审批/发送证据仍存在。

### LOCAL-REAL-006

- 模块：Gmail history polling、incremental sync/cursor、mail repository、reply matching、manual bind queue、Temporal polling workflow、mail center。
- 保护面：Gmail Token Secret Reference、邮件正文/日志脱敏、Temporal queue、Gateway/OpenAPI、`frontend/src/features/outreach/mail/**`。
- 验收命令：Gmail sync/reply unit/contract/API/integration/resilience、mail frontend source tests、Core full gate；受控收件人真实回复；轮询窗口、幂等、唯一/歧义匹配和 Worker 重启游标恢复验证。

### LOCAL-REAL-007

- 模块：Placement Candidate/import/review、static validation、browser fallback、Placement/Observation/Occurrence、MonitoringPolicy/Temporal、Links frontend。
- 保护面：crawler evidence contract、SafeFetch 安全策略、Backlinks placement migrations、Temporal registry、Gateway/OpenAPI、`frontend/src/features/outreach/links/**`。
- 验收命令：placement unit/API/integration/security、monitoring migration/replay、Core full gate、links source tests与浏览器 E2E；至少一条客户原有外链和一条新 Placement 的真实直接验证；关闭 DataForSEO 后周期监控继续。

### LOCAL-REAL-008

- 模块：Contact Gold Set harness、Placement Gold Set harness、PostgreSQL 18 recovery/RLS、Temporal replay/restart、Crawler 安全集、Provider/Gmail failure gates、质量报告。
- 保护面：Gold Set 真值与邮件正文不得入库/日志；数据库部署 manifest、迁移链、共享 crawler/browser/provider 合同。
- 验收命令：`npm run verify:backlinks`；FastAPI full Ruff/pytest；frontend typecheck/lint/build/E2E；`go test ./...`；PostgreSQL 18 clean/upgrade/backup-restore/RLS；Temporal replay/restart/duplicate delivery；100 站和 200 页指标脚本；DataForSEO 账单与本地 Ledger 对账。

### LOCAL-REAL-009

- 模块：`ops/local-product/**`、deploy composition、FastAPI/Core/Worker/Crawler/Temporal/PostgreSQL/object storage、全链路 API/UI、Runbook。
- 保护面：所有共享 compose/env、Gateway、contracts、database、crawler、frontend shell；只允许 Secret Reference，不得写原始 Secret。
- 验收命令：正式 start/status/stop/restart；listener/health/readiness/private-port 检查；001-008 全部门禁；真实项目全业务闭环；关闭 DataForSEO 复验；逐组件重启恢复；全页面 mock/`.example.invalid`/跨项目扫描。
- 最终只允许 `PASS_LOCAL_REAL_PRODUCT`、`INPUT_REQUIRED` 或 `BLOCKED`。

## 11. 通用最低命令

```powershell
# Core
Set-Location backend\core
npm run typecheck
npm run lint
npm run verify:backlinks

# FastAPI
Set-Location backend\api
uv run --frozen ruff check .
uv run --frozen pytest -q

# Frontend
Set-Location frontend
npm run typecheck
npm run lint
npm run build
npm run test:e2e:desktop
npm run test:e2e:mobile
npm run test:e2e:keyboard-a11y

# Go Crawler
Set-Location backend\crawler
go test ./...

# PostgreSQL 18 / local runtime
powershell -File backend\database\tests\verify-postgresql18.ps1
.\Status-GrowthOS-LocalProduct.ps1 -Json
```

后续任务必须再增加本任务特有的真实 Provider/真实网页/受控邮件/重启验收脚本。通用命令通过不能代替真实证据。

## 12. 状态分级

### IMPLEMENTED

- 本地真实产品验收补充协议已创建。
- LOCAL-REAL-000 现场基线、缺口和 001-009 依赖矩阵已创建。
- 当前本地 Gateway/Core/Worker/PostgreSQL/Temporal/Frontend composition 存在并运行。

### TESTED

- 修复前缺失文档检查以退出码 1 复现。
- 补充协议/result 断言和 Secret 模式扫描通过。
- Core 全门禁通过：Unit `446`、API `96`、Contract `165`、Integration `179`、Security `102`、Resilience `8`；另有 `13` 个明确环境门禁跳过。
- FastAPI Ruff 通过，full pytest `65 passed, 1 skipped`。
- Frontend typecheck、lint、build、`25/25` targeted source tests 和系统 Chrome Playwright `4/4` 通过。
- 运行状态、HTTP 200、loopback listeners、PostgreSQL 18、migration heads、73/73 forced RLS 已现场检查。
- 公共 Gateway 的 Recommendations、Opportunities、Links 当前响应已检查。
- 当前 Project、污染数据、Provider Request/Ledger 和 Kill Switch 已从 PostgreSQL 检查。
- 前端 API base、Project fallback、Recommendation 数据源和 Opportunity 按钮门禁已从当前代码检查。

### REAL_PROVIDER_VERIFIED

- `NOT_EXECUTED`。本轮真实 Provider 调用为 0。
- 历史 AI/Gmail canary 结果没有被描述为本轮真实 Provider 证据。

### BLOCKED

- `PASS_LOCAL_REAL_PRODUCT` 被 G-001 至 G-011 阻断。
- 特别是：当前 Ready Recommendation 为 0、真实项目含 canary 数据、DataForSEO 未启用、联系人主链未真实证明、加入机会门禁不符合补充协议、Placement 是 `.example.invalid`。

### INPUT_REQUIRED

- LOCAL-REAL-000 本身无需额外输入。
- LOCAL-REAL-002 预计需要 `DATAFORSEO_CREDENTIAL_SECRET_REF`、允许的 Endpoint、非 Secret 预算/调用上限与明确 canary 授权。
- LOCAL-REAL-005/006 的最终真实验收需要用户控制或明确授权的收件人、OAuth/同意交互和受控真实回复；只有实际执行到该边界时才可返回 `INPUT_REQUIRED`。

## 13. 本轮文件

- `C:\Users\DELL\Documents\缝合\GrowthOS-本地真实外链产品验收补充协议-V1.0-2026-08-04.md`
- `C:\Users\DELL\Documents\缝合\john3947-seo\backend\core\docs\execution\parallel-blocks\LOCAL-REAL-000-result.md`

没有修改历史文档原文，没有实施 `LOCAL-REAL-001` 至 `LOCAL-REAL-009`。
