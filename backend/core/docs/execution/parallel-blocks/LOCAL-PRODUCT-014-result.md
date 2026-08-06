# LOCAL-PRODUCT-014 多项目后台管线与 Project Scope 修复

- 执行日期：`2026-08-06`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-014`
- 最终状态：`PASS`
- 最终本地运行 ID：`20260806-124628`
- Organization：`11111111-1111-4111-8111-111111111111`
- Workspace：`cec65d3f-92e5-4b13-aa26-7b39e74e213a`

## 1. 结论

production Worker 已不再使用单一 `LOCAL_PRODUCT_WEBSITE_PROJECT_ID/KEY` 决定业务扫描范围。
Recommendation Refill、Contact Enrichment、Draft Generation、Gmail Sync、Backlink Profile 和
Placement Monitoring 统一从窄 `ProjectScopeProvider` 枚举当前 Organization/Workspace 内的 active
Website Project，再分别进入项目自己的 `withBacklinkTenantTransaction` 和 RLS Context。

真实本地验收中，ElephTV、AWOL Vision 和一个临时 active Project 被同一调度器公平枚举，并各创建
一个无 Provider 副作用的测试 Job。临时项目随后经公开 FastAPI Project API 归档，Core Project Context
投影为 `PAUSED`；调度器继续处理另两个项目。Worker 重启后再次枚举两个 active 项目，新增 Job 为 `0`，
原有测试 Job 总数保持 `3`。

本任务未调用 DataForSEO、AI、Gmail Send 或 Gmail Sync，未创建新队列、第二套业务权威或第二套
Provider。未执行 `LOCAL-PRODUCT-015`。

## 2. Project Scope 权威

新增的 Platform 权威函数只返回调用者当前 Organization/Workspace 内的 active Website Project，并由
Platform owner 持有。Backlinks owner 只能执行该窄函数，不能直接读取 Platform Project 表。

Backlinks `backlink_list_active_project_scopes` 将 Platform active 项目与最新
`backlink_project_context_snapshots` 交集，只返回：

- Platform 状态为 `ACTIVE`；
- 最新 Core Snapshot 状态为 `ACTIVE`；
- Platform `context_version` 与最新 Core `snapshot_version` 一致；
- 属于当前 Organization/Workspace；
- 位于确定性 UUID 游标之后且未超过有界 page limit。

这会排除已暂停、已归档、已删除、孤立、Projection Lag 和 Context Version 不一致的项目。调度器只负责
Scope 枚举、游标推进和单项目错误隔离，不读取或修改 Recommendation、Contact、Draft、Mail、Profile
或 Placement 业务状态。

## 3. Worker、RLS 与 Durable 路由

- 新增六类窄 Lane：
  `recommendation-refill`、`contact-enrichment`、`draft-generation`、`gmail-sync`、
  `backlink-profile`、`placement-monitoring`。
- 每个 Scope 使用独立 tenant transaction，设置
  `organizationId/workspaceId/websiteProjectId` RLS Context。
- production runtime 使用确定性分页、per-project 查询上限和独立错误处理；一个项目失败不会终止
  后续项目。
- Project Context 变化会把旧 Contact Enrichment Job 转为 `stale_context`；其他 Lane 也只能从匹配
  最新 active Context 的 Scope 进入 ready。
- Outbox relay 可按项目 Scope claim/mark，继续复用现有 PostgreSQL Outbox、Temporal Namespace 和
  `growthos.backlinks.v1` task queue。
- Workflow ID 已统一为：
  `backlinks:<organizationId>:<workspaceId>:<websiteProjectId>:<workflow>:v1:<instanceId>`。
- `0043` 会把旧六段 Workflow ID、Outbox idempotency key 和 payload 中的 Workflow ID 前向迁移为
  包含 Organization 的七段格式。
- Worker Project 列表不驻留内存；重启后重新从 PostgreSQL 权威函数枚举，并由现有 Outbox/Temporal
  恢复 durable 工作。

## 4. 配置与启动修复

`Set-LocalProductConfiguration.ps1` 仍允许 API、Frontend 和兼容配置保留默认 Project，但会从
`backlinks-worker.env` 删除：

- `LOCAL_PRODUCT_WEBSITE_PROJECT_ID`
- `LOCAL_PRODUCT_WEBSITE_PROJECT_KEY`

最终运行时检查结果：

| 配置 | Worker 环境 |
| --- | --- |
| `LOCAL_PRODUCT_WEBSITE_PROJECT_ID` | 不存在 |
| `LOCAL_PRODUCT_WEBSITE_PROJECT_KEY` | 不存在 |
| `LOCAL_PRODUCT_ORGANIZATION_ID` | 存在 |
| `LOCAL_PRODUCT_WORKSPACE_ID` | 存在 |

OAuth 能力校验也已解除 Worker 对默认 Project Key 的启动依赖：存在默认 Project Key 时继续精确校验回调；
不存在时只接受无凭据、无 query/hash、固定 `localhost:7200` 的项目级 Gmail callback 路径。

Alembic 启动升级改为读取既有受保护 PostgreSQL admin Secret，并只通过进程级
`ALEMBIC_DATABASE_URL` 临时传入 migration 环境；FastAPI 运行角色继续保持低权限，未持久化新凭据。

## 5. Frontend 与 Gateway

Frontend Project Query Client 的 query key 包含 Website Project；切换 Project 会取消旧
AbortController，迟到的已取消响应不会进入缓存。Generated Backlinks 和 Platform request 均支持
`AbortSignal`，且项目级路径包含 Website Project Key。

Frontend 没有新增 private Core 调用。公开请求仍经 `localhost:7200` FastAPI Gateway 转发到 private
Core。快速切换或进程重启产生的 FastAPI `ClientDisconnect` 是已定义的预期取消，服务 readiness 和后续
请求均正常，不构成业务 Gate 失败。

## 6. 真实本地验收

### 6.1 三项目公平枚举与 RLS

首次真实调度结果：

```json
{
  "outcome": {"visited": 3, "completed": 3, "failed": 0},
  "created": 3,
  "errors": []
}
```

| Project | Website Project ID | Context | 测试 Job |
| --- | --- | --- | --- |
| AWOL Vision | `4ec81dca-a0d0-40f3-9ff1-9cdff6613924` | v4 / `06420fcb-7dfc-4e53-9928-17a434d13ad4` | `14000000-0000-4000-8000-000000000002` |
| Temporary | `658521d8-da54-4336-adc7-8c38e0883bef` | v1 / `7006ee91-e41d-47f7-9c40-9aee8fdc50bf` | `14000000-0000-4000-8000-000000000003` |
| ElephTV | `e0bfde33-54bd-454a-ab61-cf7a4a48dcf0` | v1 / `243b483b-2dc6-4251-a363-9c8809a4c950` | `14000000-0000-4000-8000-000000000001` |

三个 Job 的 `job_type` 均为 `local_product_014_no_provider_probe`，状态为 `queued`。每个 Scope 内查询
Project Context Snapshot 时只看见自己的 Website Project ID，证明 writer role、tenant transaction 和
RLS 隔离生效。

### 6.2 暂停一个项目

通过公开 API：

```text
POST /api/v1/projects/local-product-014-example-com-658521d8/archive
```

Platform Project 变为 `ARCHIVED / context_version=2`，Core 新 Snapshot 为
`PAUSED / snapshot_version=2`。公开 active Project 列表和窄 Scope 函数随后只返回 AWOL Vision 与
ElephTV。

再次调度结果：

```json
{
  "outcome": {"visited": 2, "completed": 2, "failed": 0},
  "created": 0,
  "errors": []
}
```

### 6.3 Worker 重启恢复

使用全部 Provider 关闭的正式脚本完成重启，最终运行 ID 为 `20260806-124628`。重启后：

- Frontend `5173`、FastAPI `7200`、Private Core `7301` 均返回 `200`；
- PostgreSQL `55432` healthy，Temporal `57233/59090` healthy；
- Alembic Head：`20260806_0009`；
- Backlinks Head：`0044`；
- Worker 输出 `backlinks.worker.ready` 并进入 Temporal `RUNNING`；
- 再次调度仍为 `visited=2 / completed=2 / failed=0 / created=0`；
- 测试 Job 总数仍为 `3`。

## 7. Provider 零副作用

本轮开始、暂停后和重启后的 Provider 事实保持一致：

| 事实 | 开始 | 最终 |
| --- | ---: | ---: |
| DataForSEO usage ledger rows | 3 | 3 |
| Estimated cost micros | 155200 | 155200 |
| Actual cost micros | 82800 | 82800 |
| Provider batch requests | 6 | 6 |
| Gmail SendIntent / SendAttempt | 0 / 0 | 0 / 0 |
| Gmail Sync cursor / message | 0 / 0 | 0 / 0 |

最终开关为 `DataForSEO=false`、`AI=false`、`Gmail Send=false`、`Gmail Sync=false`、
`Browser=false`。因此本任务 DataForSEO、AI、Gmail Send 和 Gmail Sync 外部调用增量均为 `0`。

## 8. Migration

- Alembic `20260806_0009`：Platform active Website Project 窄权威函数和最小跨 Schema grant。
- Backlinks `0043`：Project Scope Provider、内部 Snapshot policy、Workflow ID 前向升级、
  `stale_context`。
- Backlinks `0044`：Platform Project 权威与最新 Core Project Context 的交集。
- Deployment Manifest Head：Alembic `20260806_0009`、Backlinks `0044`。

PostgreSQL 18.4 定向完整验证：

- clean install：PASS；
- existing upgrade 与 DataForSEO write compatibility：PASS；
- migration/RLS/function authority：PASS；
- backup/restore：PASS；
- 恢复后 `75` tables、`3` recovery facts；
- RPO：`0.293s`；
- RTO：`40.199s`。

## 9. 定向测试

### Core

- `npm run typecheck`：PASS。
- `npm run lint`：PASS。
- `npm run build`：PASS。
- `npm run migration:backlinks:check`：`37` files through `0044`，PASS。
- Scope/runtime/config/live capability Unit：`4` files / `46` tests，PASS。
- Scope Provider、RLS、Outbox、Temporal、Workflow Namespace Integration/Contract：
  `5` files / `17` tests，PASS。
- PostgreSQL Scope Provider 独立 Integration：PASS。

### FastAPI

- Project authority/context、local product config、migration system pytest：
  `38 passed`。
- Ruff：PASS。

### Frontend

- Project switching/cache isolation tests：`4 passed`。
- Generated Backlinks client：`58` operations valid。
- Generated Platform client：`6` operations valid。
- typecheck：PASS。
- lint：PASS。
- build：PASS；仅有既有大于 `500 kB` chunk 警告。

## 10. 文件与边界

主要新增文件：

- `project-scope-provider.port.ts`
- `project-scope.repository.ts`
- `project-scope-scheduler.ts`
- `0043_backlink_project_scope_provider.sql`
- `0044_backlink_platform_project_authority.sql`
- `20260806_0009_backlinks_project_scope_authority.py`
- `project-scope-provider.test.ts`
- `project-scope-scheduler.test.ts`

production `production-runtime.ts` 中不存在
`LOCAL_PRODUCT_WEBSITE_PROJECT_ID/LOCAL_PRODUCT_WEBSITE_PROJECT_KEY` 业务扫描路径。默认 Project 配置只
保留在 UI/API/兼容边界和受限 OAuth callback 校验中。

- 未清空正式本地 PostgreSQL 或 Temporal。
- 未调用 GSC。
- 未 commit。
- 未 push。
- 未执行 `LOCAL-PRODUCT-015`。
