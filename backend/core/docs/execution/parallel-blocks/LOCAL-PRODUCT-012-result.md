# LOCAL-PRODUCT-012 多 Website Project 创建与切换

- 执行日期：`2026-08-05`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-012`
- 状态：`PASS`
- 最终本地运行 ID：`20260805-155652`
- Organization：`11111111-1111-4111-8111-111111111111`
- Workspace：`cec65d3f-92e5-4b13-aa26-7b39e74e213a`

## 1. 结论

本地产品已取消 ElephTV 单项目写死。公开 Project API、左侧项目选择器和项目管理页现在从
Platform/PostgreSQL 权威读取当前主体有权访问的全部 active Website Project；启动配置中的
`LOCAL_PRODUCT_WEBSITE_PROJECT_KEY=elephtv` 只保留为默认项目，不再充当唯一 allowlist。

已经按用户提供的真实资料创建第二个 Website Project：

| 字段 | 值 |
| --- | --- |
| 名称 | `AWOL Vision` |
| Domain | `awolvision.com` |
| Project ID | `4ec81dca-a0d0-40f3-9ff1-9cdff6613924` |
| Project Key | `awolvision-com-4ec81dca` |
| 国家 / 目标市场 | `US` / `United States` |
| 语言 | `en` |
| 关键词 | `home cinema` |
| Products / Target URLs | 空，等待真实资料 |
| 当前状态 | `ACTIVE` |
| Context Version | `3` |

AWOL 可以创建、切换、刷新恢复、归档和恢复。切到 AWOL 后保持原模块路由，但 Recommendation、
Opportunity、Draft、Mail、Links 和 Gmail 都显示该项目自己的真实空状态，没有显示 ElephTV 数据。

Gmail 已改为 Website Project 级绑定。同一个 Gmail 账号也必须在每个项目中重新执行一次显式
OAuth 连接，形成独立 Gmail Connection、Token Secret Reference 和 Project Binding；不会复用或
复制 ElephTV 的 Token。当前 ElephTV 仍连接 `tianyulong23@gmail.com`，AWOL 为未连接状态。

## 2. Platform Project 权威

- `/api/v1/projects` 当前返回两个 active、非 fixture、非归档项目：AWOL Vision 和 ElephTV。
- Project 列表应用 Organization、Workspace、复合归属和 RLS，不从前端环境变量扩展权限。
- 创建、更新、归档、恢复均由正式 Platform command/API 执行，前端不直接写数据库。
- Project、WebsiteProfileVersion、PromotionTargetVersion、Audit、Outbox 在同一服务端事务提交。
- Core 只接收 FastAPI 传递的已验证 Project 上下文，并持久化 Project Context Snapshot。
- 没有新增第二套 Project 表、内存注册表、Gateway 业务状态或平行 Provider 实现。

AWOL 的 PostgreSQL 历史：

| Context Version | Audit Event | Project Snapshot |
| ---: | --- | --- |
| `1` | `WEBSITE_PROJECT_CREATED` | `ACTIVE` |
| `2` | `WEBSITE_PROJECT_ARCHIVED` | `PAUSED` |
| `3` | `WEBSITE_PROJECT_RESTORED` | `ACTIVE` |

WebsiteProfileVersion、PromotionTargetVersion 和 Core Project Context Snapshot 均各有 `3` 个版本；
三个 Platform Outbox Event 均为 `published`。归档期间普通 Project 列表不返回 AWOL，当前项目自动
回退到 ElephTV；恢复后可再次切换到 AWOL。

AWOL 的 `input_required` 为 `products` 和 `target_urls`。因此项目可以正常进入和维护，但没有创建
Recommendation 补货 Job，也没有使用 ElephTV 的产品、URL、关键词、缓存或 Provider 结果代替。

## 3. 前端创建、管理与切换

添加项目入口：

1. 左侧边栏顶部当前项目选择器，展开后选择 `新建项目`。
2. 同一菜单的 `管理项目` 进入 `外链 > 网站项目`，页面内也有 `新建项目`。

整个前端只保留一个 `CurrentProjectContext`，其权威来源是
`/projects/{websiteProjectKey}/...` 路由和服务端授权 Project 列表。项目切换时：

- 保持当前模块，例如从 ElephTV 邮件页切换到
  `/projects/awolvision-com-4ec81dca/backlinks/email`。
- abort 旧项目在途请求，query key 以 Project Key 开头。
- 清除旧项目 Opportunity、Draft Job、Mail Thread、Link Detail 和临时表单选择。
- 拒绝把迟到响应渲染到新项目上下文。
- 刷新、前进/后退和直接访问项目 URL 时从 route 恢复相同项目。
- Project 列表、创建、更新、归档和恢复全部调用 generated Platform client。

真实浏览器验收结果：

| 场景 | 结果 |
| --- | --- |
| 创建 AWOL | 成功，公开 API 与 PostgreSQL 字段一致 |
| ElephTV -> AWOL | 保持邮件模块，显示 AWOL 空状态 |
| AWOL 页面刷新 | 仍为同一个 Project Key 和模块 |
| 归档 AWOL | 从 active 列表移除并回退 ElephTV |
| 恢复 AWOL | 回到 active 列表，可重新切换 |
| 切换器内容 | 同时显示 AWOL、ElephTV、新建项目、管理项目 |

## 4. 项目隔离证明

最终 PostgreSQL 项目事实：

| 事实 | ElephTV | AWOL Vision |
| --- | ---: | ---: |
| Recommendation | `20` | `0` |
| Opportunity | `7` | `0` |
| Draft | `3` | `0` |
| Mail Message | `0` | `0` |
| Placement / Link | `1` | `0` |
| Model Run | `4` | `0` |
| DataForSEO Batch | `3` | `0` |
| Provider Request | `3` | `0` |
| SendIntent | `0` | `0` |
| SendAttempt | `0` | `0` |
| Project Context Snapshot | `1` | `3` |

公开 Gateway 重新读取结果：

- ElephTV Recommendation `20`，Opportunity `7`。
- AWOL Recommendation `0`，Opportunity `0`。
- 每个响应的 `meta.websiteProjectId` 都与 URL 中的 Project Key 对应。
- AWOL Gmail status 为 `connection: null`。
- ElephTV Gmail status 返回自己的 active connection 和 Project ID。

Gmail binding migration 将主键边界收紧为
`organization + workspace + website_project + gmail_connection`，同一 Connection/Token 不能同时绑定
两个 Website Project。相同 Gmail 邮箱可以在 AWOL 中重新授权，但必须生成新的 Connection、Token
Reference 和 AWOL binding。

Provider、Recommendation、Opportunity、Draft、Send、Mail Sync/History、Placement 和 Monitoring
查询继续带 `website_project_id`。AWOL 没有回退读取 ElephTV 的 Provider cache、预算结果或业务事实。

## 5. 契约与迁移

- 公开共享 OpenAPI：`77 paths / 83 operations`。
- generated Platform client：`6` 个 Project operations。
- generated Backlinks client：`58` 个 operations。
- Project list/create/get/update/archive/restore 均来自冻结 Platform OpenAPI。
- 没有新增 handwritten Project client 或开发环境 fallback。

迁移：

| Migration | SHA-256 |
| --- | --- |
| `20260805_0008_website_project_authority.py` | `f47eab47d20ff1e21e78d4a68f4c47cfdf8a4b16cca955421643fdc647545966` |
| `0041_backlink_gmail_project_bindings.sql` | `2fc8f8da3dff626c3df210f3991062371c58c831757622f131c0ace6dd094b29` |

迁移前备份：

- `C:\Users\DELL\AppData\Local\GrowthOS\live001\backups\local-product-012-20260805-150524.dump`
  （`706343` bytes）
- `C:\Users\DELL\AppData\Local\GrowthOS\live001\backups\local-product-012-gmail-project-20260805-155032.dump`
  （`729358` bytes）

最终数据库 head：Alembic `20260805_0008`，Backlinks `0041`。ElephTV ID 和既有
Recommendation、Opportunity、Draft、Gmail、Placement 事实均保持不变，未清空或重建数据库。

## 6. 外部调用与范围边界

当前 Organization/Workspace 的验收前后计数保持：

| 调用/事实 | 验收前 | 验收后 | 012 新增 |
| --- | ---: | ---: | ---: |
| AI Model Run | `4` | `4` | `0` |
| DataForSEO Batch | `3` | `3` | `0` |
| DataForSEO Provider Request | `3` | `3` | `0` |
| Gmail SendIntent | `0` | `0` | `0` |
| Gmail SendAttempt | `0` | `0` | `0` |

最终验收运行中 DataForSEO、AI、Gmail Send、Gmail Sync 和 Browser Worker 均为 disabled。
没有调用 AI、DataForSEO、Gmail Provider 或产品 Browser Worker，没有发送邮件，也没有启动 AWOL
Recommendation 补货。Playwright 只操作本地公开产品页面。

## 7. 测试与真实运行

| 验证 | 结果 |
| --- | --- |
| Project/FastAPI/Gateway 定向 pytest | `45 passed` |
| API database migration system | `4 passed` |
| PostgreSQL migration/RLS tests | `4 passed` |
| Gmail Project binding integration | `4 files / 26 tests passed` |
| Frontend Project/query/source tests | `7/7 passed` |
| Local Product process script tests | `12 passed` |
| Core typecheck / lint / build | passed |
| Frontend typecheck / lint / production build | passed |
| Python Ruff | passed |
| 定向真实浏览器创建/切换/刷新/归档/恢复 | passed |
| `git diff --check` | 无 whitespace error；仅 Windows LF/CRLF 提示 |

Frontend build 只有既有的单 chunk 大于 `500 kB` 警告。Provider-disabled 验收运行中，ElephTV
邮件同步状态命令按现有边界返回 unavailable，页面显示“暂时无法读取同步状态，已保存邮件不受影响”；
AWOL 页面只显示重新连接 Gmail，不继承 ElephTV 连接。

最终健康状态：

- Frontend `http://localhost:5173`：`200`
- FastAPI Gateway `http://localhost:7200`：`200`
- private Core `http://127.0.0.1:7301`：`200`
- PostgreSQL 18：healthy
- Temporal：healthy，namespace ready
- Browser Worker：按验收配置 disabled

浏览器证据：

- `output/playwright/local-product-012-create-project.png`
- `output/playwright/local-product-012-project-switcher.png`
- `output/playwright/local-product-012-awol-restored.png`
- `frontend/output/playwright/local-product-012-awol-gmail-reconnect.png`

## 8. 实际耗时

可由数据库和最终验收时间精确追溯的第二项目验收窗口：

- AWOL 创建：`2026-08-05 15:22:56 +08:00`
- 最终事实核对：`2026-08-05 16:10:50 +08:00`
- 创建至最终 PASS：`47m 54s`

时间主要用于补齐 Project 权威、generated contract、跨模块请求隔离，以及发现并修复 Gmail 原本只按
Workspace 绑定、会让新项目继承 ElephTV 连接的问题；不是 Provider、AI 或邮件发送等待。

## 9. 最终状态

`PASS`

`LOCAL-PRODUCT-012` 的真实多项目列表、创建、资料维护、归档恢复、模块内切换、刷新恢复、
Platform/Core/PostgreSQL 贯通及 Gmail/Provider/Backlinks 项目隔离均已实现并通过测试与真实浏览器验收。

AWOL 已建立为第二个真实网站。它当前因缺少 Products 和 Target URLs 保持 `INPUT_REQUIRED`，
且 Gmail 必须在 AWOL 项目内重新连接，即使使用与 ElephTV 相同的 Gmail 账号。

未执行 `LOCAL-PRODUCT-013`，未重新执行或改写 `LOCAL-REAL-000..009` 和
`LOCAL-PRODUCT-010..011`，未执行 Git commit/push。完成后停止，等待用户确认。
