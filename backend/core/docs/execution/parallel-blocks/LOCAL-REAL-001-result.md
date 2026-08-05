# LOCAL-REAL-001 项目主数据与演示数据隔离结果

- 执行日期：`2026-08-04`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-REAL-001`
- 阶段结果：`PASS_LOCAL_REAL_001`
- 当前本地产品：`RUNNING`
- 公共入口：`http://localhost:5173`

## 1. 状态结论

| 状态 | 结论 |
| --- | --- |
| `IMPLEMENTED` | 已完成真实 Website Project 权威读取、前端静态项目权威移除、Recommendation 历史状态兼容、旧 canary 数据归档隔离和字段职责收敛。 |
| `TESTED` | Core TypeScript、lint、Unit、API、Contract、Integration、Security、Resilience，FastAPI pytest/ruff，Frontend typecheck/lint/build、项目切换隔离测试和真实浏览器检查均通过。 |
| `REAL_PROVIDER_VERIFIED` | `NOT_EXECUTED_BY_DESIGN`。001 禁止调用 DataForSEO、AI、Gmail；本轮验证的是 Provider 零调用边界，不代表任何 Provider 功能已完成真实验证。 |
| `BLOCKED` | 001 范围内无阻塞项。后续 002-009 未在本轮执行。 |
| `INPUT_REQUIRED` | 当前真实项目仍缺少非 Secret 主数据：`keywords`、`products`、`target_urls`。页面和公共 API 均明确返回 `INPUT_REQUIRED`，未虚构内容。 |

## 2. 权威边界

本轮按用户指定顺序读取并遵守 Production Baseline、共享仓库/SEO-V4 补充协议、开发需求、整合实施需求、后端 Coding 计划、AI 分步指令、并行补丁、DataForSEO Cost Control、对应 ADR/Contract/Migration/Test/Coding State，以及本轮完整指令文件中的 `LOCAL-REAL-001`。

保持的运行架构：

```text
React SPA -> FastAPI Gateway -> private Fastify Backlinks Core -> Temporal
Temporal -> Backlinks Worker / Go Crawler
PostgreSQL -> business source of truth
```

未新增第二套项目、鉴权、队列、Crawler、Browser Worker、CRM 或业务状态机。浏览器实测只访问公共 FastAPI Gateway。

## 3. 修复前失败证据

修复前可复现：

1. 公共 Gateway 没有可用的 `/api/v1/projects` 产品接口。
2. `Recommendation status=accepted` 被参数校验拒绝，合法历史状态不能读取。
3. 当前 ElephTV 产品上下文使用 LIVE canary Workspace/Project，包含 `.example.invalid`、QQ 邮箱、canary Opportunity/Placement/Mail 等历史演示或受控验证数据。
4. 前端 `initialProjects`/静态数据仍可控制项目页面和任务/通知展示。

失败测试和证据先建立，再实施最小范围修复：

- `backend/api/tests/test_local_product_projects.py`
- `backend/core/test/backlinks/api/recommendations-route.test.ts`
- `backend/core/test/unit/local-real-project-authority.test.ts`
- `backend/core/test/unit/local-real-project-isolation-script.test.ts`
- 修复前公共 API、PostgreSQL 分类和浏览器页面抓取记录

## 4. 数据备份、分类与隔离

执行脚本：

```text
ops/local-product/Isolate-GrowthOS-LocalProductProjectData.ps1
```

脚本行为：

1. 产品端口仍在监听时拒绝执行变更。
2. 变更前执行 PostgreSQL custom-format 备份。
3. 使用 `pg_restore --list` 验证备份。
4. 按所有带 organization/workspace/project 作用域的 Backlinks 表分类旧数据。
5. 保留旧数据图，不删除测试 fixture。
6. 将旧 LIVE 项目标记为归档 canary，并建立新的真实本地产品 Workspace/Project。
7. 新项目只创建一个 `local-real-001-project-isolation` context snapshot；其余业务表保持空。
8. 不包含 DataForSEO、AI 或 Gmail HTTP 调用。

备份证据：

- 路径：`C:\Users\DELL\AppData\Local\GrowthOS\live001\backups\LOCAL-REAL-001-20260804-110425.dump`
- 格式：`postgres-custom`
- 大小：`603073` bytes
- `pg_restore --list`：退出码 `0`
- TOC 条目：`891`
- 隔离回执：`C:\Users\DELL\AppData\Local\GrowthOS\live001\local-real-001-isolation.json`

归档数据保持在旧测试上下文：

- Workspace：`22222222-2222-4222-8222-222222222222`
- Project：`33333333-3333-4333-8333-333333333333`
- 名称：`LIVE-001 Canary Archive`
- 域名：`live001-canary.example.invalid`
- 旧图仍包含 Recommendation `2`、Opportunity `2`、Contact `1`、Placement `1`、Mail Message `4` 等历史 canary 数据，但不再属于当前产品上下文。

当前真实产品上下文：

- Organization：`11111111-1111-4111-8111-111111111111`
- Workspace：`cec65d3f-92e5-4b13-aa26-7b39e74e213a`
- Website Project：`e0bfde33-54bd-454a-ab61-cf7a4a48dcf0`
- Website Project Key：`elephtv`
- 名称：`ElephTV`
- 域名：`elephtv.com`
- 市场/语言：`US` / `en`
- Platform health：`100`

当前真实上下文数据库计数：

- Project context snapshot：`1`
- Recommendation：`0`
- Opportunity：`0`
- Contact：`0`
- 其余已分类 Backlinks 业务表：`0`

## 5. 实现内容

### FastAPI 公共 Gateway

- 新增只读 `GET /api/v1/projects`，复用现有 Platform Context Resolver。
- 项目详情从 PostgreSQL `platform.projects` / `platform.site_profiles` 读取。
- 只返回当前受控本地产品 Website Project，不枚举或回退到 canary 项目。
- 映射 domain、country、language、health、keywords、products、target URLs。
- 缺少项目资料时返回 `input_required`，不生成假关键词、产品或 URL。

### Fastify Backlinks Core

- Recommendation 列表合法状态统一为：

```text
ready, claimed, shown, rejected, stale_context, accepted
```

- `accepted`、`shown`、`stale_context` 现场查询均返回 HTTP `200`，不再因合法数据库状态出现 400/500。

### React SPA

- 项目上下文启动时从公共 `/api/v1/projects` 读取。
- 删除产品运行中的静态 `initialProjects`/base project fallback。
- 环境项目 key 与公共 API 返回不一致时 fail closed。
- 删除 app shell 中演示任务、演示通知和虚构账户信息。
- 项目页只读展示 Platform/PostgreSQL 权威字段。
- Opportunity 网站列使用 `item.targetHostAscii`。
- 邮件收件人显示正式 Contact 的 `normalizedEmail`。
- 任务中心只展示服务端 Task；当前无服务端任务时显示 `0 个任务`，不生成演示任务。

## 6. API 与隔离现场

公共 API：

- `GET /api/v1/projects`：HTTP `200`，只返回一个 `ElephTV / elephtv.com`。
- `GET .../recommendations?status=accepted`：HTTP `200`，空集合。
- `GET .../recommendations?status=shown`：HTTP `200`，空集合。
- `GET .../recommendations?status=stale_context`：HTTP `200`，空集合。
- 三个响应的 meta 均为当前 Organization/Workspace/Website Project。

越界请求：

- `live001-canary`：HTTP `403 LOCAL_PRODUCT_PROJECT_DENIED`
- `live002-isolation`：HTTP `403 LOCAL_PRODUCT_PROJECT_DENIED`
- `publisher-live002`：HTTP `403 LOCAL_PRODUCT_PROJECT_DENIED`
- `foreign`：HTTP `403 LOCAL_PRODUCT_PROJECT_DENIED`

## 7. 自动化门禁

### Core

| Gate | 结果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| Unit | `82` files，`451` tests passed |
| API | `30` files，`99` tests passed |
| Contract | `24` files，`165` tests passed |
| Integration | `49` files passed，`4` skipped；`179` tests passed，`13` skipped |
| Security | `9` files，`102` tests passed |
| Resilience | `3` files，`8` tests passed |
| LOCAL-REAL-001 targeted | `3` files，`10` tests passed |

Integration 日志中的 `BL_AI_041_INJECTED_WORKER_INTERRUPTION` 是测试定义的中断注入；最终 Integration suite 通过。

### FastAPI

| Gate | 结果 |
| --- | --- |
| `pytest test_local_product_projects + authoritative context + auth contract + backlinks gateway` | `36 passed` |
| `ruff check app tests/test_local_product_projects.py` | PASS |

### Frontend

| Gate | 结果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS |
| Project query isolation | `4 passed` |

构建仅保留既有的大 chunk warning，不影响本轮功能或本地运行。

## 8. 真实运行与重启

当前运行记录：

- 首次隔离后运行：`20260804-110614`
- 停止并重新启动后运行：`20260804-111243`
- 当前 runtime mode：`LOCAL_PRODUCT`
- 当前 process manifest project key：`elephtv`
- 重启前后持久 identity 的 Organization/Workspace/Website Project 未变化。

当前监听与健康：

| 组件 | 地址 | 状态 |
| --- | --- | --- |
| React SPA | `127.0.0.1:5173` | HTTP `200` |
| FastAPI Gateway | `127.0.0.1:7200` | `/health` HTTP `200` |
| Fastify Core | `127.0.0.1:7301` | `/health` HTTP `200` |
| PostgreSQL | `127.0.0.1:55432` | container `healthy` |
| Temporal | `127.0.0.1:57233` | container `healthy` |

重启后的 `/api/v1/projects` 和 Core meta 仍返回同一个 `elephtv` Website Project，满足重启持久性要求。

## 9. 真实浏览器验证

使用真实 Playwright 浏览器访问当前运行中的 React SPA，没有安装 route mock。

验证页面：

- `/projects/elephtv/backlinks/recommendations`
- `/projects/elephtv/backlinks/projects`
- `/projects/elephtv/backlinks/opportunities`
- `/projects/elephtv/backlinks/email`

网络请求只指向公共 Gateway：

```text
GET http://localhost:7200/api/v1/projects
GET http://localhost:7200/api/v1/projects/elephtv/backlinks/recommendations
GET http://localhost:7200/api/v1/projects/elephtv/backlinks/opportunities
GET http://localhost:7200/api/v1/projects/elephtv/backlinks/mail/messages
GET http://localhost:7200/api/v1/projects/elephtv/backlinks/gmail-connections/status
```

浏览器没有直连 Core、Crawler、Temporal 或 PostgreSQL。Gmail connection status 是读取 Core/PostgreSQL 状态，不是 Gmail Provider 调用。

页面结果：

- 当前项目为 `ElephTV / elephtv.com`。
- 项目资料缺口显示 `INPUT_REQUIRED`。
- 推荐池为空，不回退 mock。
- Opportunity 四项计数均为 `0`，不回退本地机会数据。
- 邮件列表为空，没有 QQ 邮箱或演示邮件。
- 任务中心显示 `0 个任务 / 暂无服务端任务`。
- 浏览器 console：`0 errors`。
- 未发现：
  - `publisher-live002.example.invalid`
  - `live001-canary.example.invalid`
  - `qq.com`
  - `watchwise.io`
  - `streamscope.co`

截图：

- `frontend/output/playwright/local-real-001-final-recommendations.png`
- `frontend/output/playwright/local-real-001-final-project.png`
- `frontend/output/playwright/local-real-001-final-opportunities.png`

## 10. Provider 零调用证据

本轮没有执行 DataForSEO、AI 或 Gmail Provider 动作：

- `backlinks.backlink_provider_requests`：`0`
- `backlinks.backlink_provider_usage_ledger`：`0`
- 隔离回执：
  - `dataForSeo=false`
  - `ai=false`
  - `gmail=false`
- 当前运行的 Core/API/Worker/Frontend 日志没有匹配 DataForSEO、Gmail API、OpenAI/Generative Language 或 provider request 调用标记。

该证据只证明 001 的禁止调用边界成立，不证明 Provider 的真实能力已验证。

## 11. 本轮文件

主要实现：

- `backend/api/app/api/routes/projects.py`
- `backend/api/app/api/router.py`
- `backend/api/app/main.py`
- `backend/api/app/modules/projects/authority.py`
- `backend/core/src/modules/backlinks/application/queries/recommendations.query.ts`
- `backend/core/src/modules/backlinks/api/recommendations.route.ts`
- `frontend/src/app/project-context.ts`
- `frontend/src/app/app-shell.tsx`
- `frontend/src/features/projects/project-workspace.tsx`
- `frontend/src/pages/settings-page.tsx`
- `ops/local-product/Isolate-GrowthOS-LocalProductProjectData.ps1`

测试：

- `backend/api/tests/test_local_product_projects.py`
- `backend/core/test/backlinks/api/recommendations-route.test.ts`
- `backend/core/test/unit/local-real-project-authority.test.ts`
- `backend/core/test/unit/local-real-project-isolation-script.test.ts`
- `frontend/test/support/outreach-api-fixtures.ts`

证据：

- `backend/core/docs/execution/parallel-blocks/LOCAL-REAL-001-result.md`
- `frontend/output/playwright/local-real-001-final-recommendations.png`
- `frontend/output/playwright/local-real-001-final-project.png`
- `frontend/output/playwright/local-real-001-final-opportunities.png`

未执行 Git commit 或 push，未撤销用户已有改动。
