# LOCAL-REAL-008-FAST 执行结果

- 执行日期：2026-08-05
- 状态：`PASS_LOCAL_FUNCTION`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- Website Project：`elephtv`
- Project ID：`e0bfde33-54bd-454a-ab61-cf7a4a48dcf0`
- Workspace ID：`cec65d3f-92e5-4b13-aa26-7b39e74e213a`
- 本地运行 ID：`20260805-100109`

## A. 综合代码门禁

### Core

`npm run verify:backlinks` 已通过：

- typecheck：passed
- lint：passed
- source manifest：`28` 项通过
- dependency allowlist：passed
- license scan：`693` 项通过
- OpenAPI：`56` paths
- Backlinks migrations：`33` 个 migration，head `0040`
- unit：`85` files，`478` tests passed
- API：`30` files，`101` tests passed
- contract：`26` files，`169` tests passed
- integration：`49` files passed、`4` skipped；`183` tests passed、`13` skipped
- security：`9` files，`105` tests passed
- resilience：`3` files，`8` tests passed

综合门禁后新增的本地启动治理初始化修复，已单独执行
`local-product-process-scripts.test.ts`，`10/10` tests passed。

### FastAPI Gateway

- Ruff：passed
- pytest：`66 passed, 1 skipped`
- migration manifest、共享 Contract、项目权威和 Gateway 转发测试均通过

### Frontend

- typecheck：passed
- lint：passed
- build：passed，Vite `8.1.5`，`2310` modules transformed
- Outreach source tests：`41/41 passed`
- desktop E2E：`2/2 passed`
- mobile E2E：`1/1 passed`
- keyboard/axe E2E：`1/1 passed`

### Browser Worker

- typecheck：passed
- build：passed
- tests：`1/1 passed`
- 本地运行继续复用仓库现有 Browser Worker/Playwright Adapter，没有新增第二套 Worker 或 Queue

### Go Crawler

本机没有原生 Go，使用本机已有 Docker 镜像执行：

`docker run --rm -v "${PWD}:/workspace" -w /workspace golang:1.25.4 go test ./...`

结果：

- `cmd`：无测试文件
- `internal/crawler`：passed
- `internal/worker`：passed

本地产品启动、重启和状态脚本均未把 Go Crawler 注册为当前真实链的依赖；当前 Placement 验证由 Core
SafeFetch 和共享 Browser Worker 完成，因此 Go Crawler 没有被错误设为业务必需。

## B. PostgreSQL、Manifest 和 RLS

- PostgreSQL：`18.4`
- 数据库：`growthos_live001`
- 数据库状态：healthy，非 recovery
- FastAPI Alembic head：`20260724_0007`
- Backlinks migration head：`0040`
- deployment manifest：与两个当前 head 一致
- Backlinks tables：`75`
- RLS enabled：`75/75`
- FORCE RLS：`75/75`
- policies：`92`

本轮真实读取发现当前 ElephTV 项目缺少 settings/retention 初始版本，导致设置接口返回 `500`。
启动脚本已改为按实际 organization/workspace/project 幂等初始化：

- settings version `1`
- reporting timezone `Asia/Shanghai`
- report lookback `30` days
- export expiry `24` hours
- retention version `1`
- operational retention `30` days
- `audit_record`、`lifecycle_record`、`active_suppression` 例外

重启后数据库各有 `1` 个当前项目版本，设置 API 返回 `200`，且返回 `6` 个分层 Kill Switch。

## C. Temporal、幂等和恢复

Temporal 定向测试结果：

- `5` files passed，`1` skipped
- `20` tests passed，`2` skipped
- 覆盖 workflow/activity 注册、outbox relay、Repository 幂等和 workflow definitions

Core 综合 Gate 的 worker 故障注入验证了：

1. Worker 进入 `STOPPING`、`DRAINING`、`STOPPED`。
2. Worker 重新启动并回到 `RUNNING`。
3. 已提交 workflow 恢复并成功完成，没有重复业务写入。

当前 Temporal 服务、namespace 和 Backlinks Worker 均 healthy。内部 namespace 仍保留历史名称
`growthos-backlinks-canary`，但它没有作为 Product API/UI 的项目、授权门禁或用户数据暴露。

## D. Product API/UI 真实性与隔离

真实 API 复验：

- `/api/v1/projects`：只返回一个当前项目 `ElephTV / elephtv.com`
- summary：`200`
- recommendations：`200`，`20` 条
- opportunities：`200`，`4` 条
- links：`200`，`2` 条
- Gmail status：`200`，connected
- settings：`200`，settings version `1`、retention version `1`、Kill Switch `6` 条

四个非当前 project key 请求全部返回 `403`，包括历史 UUID、历史 key 和不存在 key。
数据库内保留的两个 archived 历史隔离项目没有从 `/api/v1/projects`、Backlinks API 或 UI 泄露。

真实 Placement 详情返回 `200`：

- Source：`https://elephtv.africa/`
- Target：`https://elephtv.com/become-an-elephtv-reseller/`
- initial validation：`VALID`
- lifecycle：`active`
- monitoring：`enabled`
- latest observation：`present`
- execution mode：`static`
- freshness：`fresh`
- browser fallback：enabled

Backlinks production API/UI 源码扫描未发现：

- mock 或 fixture 作为生产事实源
- canary 或 `.example.invalid` 作为当前项目数据
- 跨项目数据
- task/email 名称冒充 Website Project
- fake adapter 被生产入口引用

仓库其他 SEO 模块仍有各自的演示数据和测试 fixture；它们不进入 Backlinks API、generated client、
Outreach 页面或本轮真实业务计数。Core 中的历史 canary 兼容检查和 `.example.invalid` 拒绝校验仍保留，
用途是拒绝旧配置，不是当前产品数据。

## E. Secret、Token 和日志扫描

仓库凭据特征扫描结果：

- private key：`0`
- Google API key：`0`
- Google OAuth client ID：`0`
- Google refresh/access token：`0`
- GitHub token：`0`
- Secret/Token/Authorization Code 日志语句：`0`

一个 OpenAI key 正则命中被核对为测试标识符误报，不是引号包裹的 key，也没有赋给 token/secret/key 字段。

- 历史本地运行日志：`596` files，敏感值命中 `0`
- 当前运行日志：`10` files，敏感值命中 `0`
- 当前日志中的一条 ASGI 异常是浏览器取消邮件请求产生的 `ClientDisconnect`；服务继续 healthy，
  同一业务面和设置接口复验均为 `200`，没有可复现业务 `500`

合法 Secret Reference、现有 Gmail 连接和 Provider 配置均被复用；结果文件和日志未写入 Secret 值、
OAuth code、PKCE 或 Token。

## F. Provider 治理和紧急关闭

本地状态输出和真实设置 UI 已显示：

- DataForSEO：显式 enable、最大付费调用数、候选上限、单次估算成本、绝对预算、Ledger 和
  project/provider 两级 Kill Switch
- AI：显式 enable、最大调用数和绝对美元预算
- Gmail：send/sync 独立 enable、滚动发送上限、最小发送间隔、项目 Kill Switch
- Browser：显式 enable、超时、最大页面数、最大尝试数、项目 Kill Switch
- 紧急关闭：项目层和 Provider 层均可见，父级阻断优先

当前运行：

- AI：enabled
- Gmail send/sync：enabled
- Browser：enabled
- DataForSEO：本次 Gate 未启用付费调用，避免为测试产生额外费用
- DataForSEO budget：limit `100000` micros，spent `55200` micros，reserved `0`
- DataForSEO Ledger：`2` 个 settled entries，actual `55200` micros

启动脚本已验证显式 `Enable` 会自动打开实际 Website Project 对应的数据库 Kill Switch，不再出现
环境变量 enabled、数据库仍 blocked 的常态。DataForSEO 调用上限支持 `1..1000` 配置，不再固定为一次调用。

真实浏览器验证：

- URL：`http://localhost:5173/projects/elephtv/settings/outreach`
- 页面：`指标与治理设置`
- settings version：`1`
- Retention 和 `6` 个能力开关可见
- 浏览器 console errors：`0`
- `设置读取失败`：`0`
- 截图：`frontend/output/playwright/local-real-008-settings.png`

## G. 真实本地栈

- Frontend：`5173`
- FastAPI Gateway：`7200`
- Core：`7301`
- Browser Worker：`7401`
- PostgreSQL：`55432`
- Temporal：`57233`
- Temporal metrics：`59090`
- health/readiness：全部 healthy

Gmail callback 按真实 project key 动态生成：

`http://localhost:7200/api/v1/projects/elephtv/backlinks/gmail-connections/callback`

本轮完成了一次真实 stop/start 后的运行验证；Project、Recommendation、Opportunity、Gmail connection、
Draft、Placement、Observation、MonitoringPolicy、budget 和 Ledger 数据均保留。

## QUALITY-BACKLOG-001

以下发布质量工作已登记为非阻塞 backlog，没有伪装为本轮完成：

1. `100` 个真实网站 Contact 人工真值 Gold Set。
2. `200` 页 Placement Gold Set。
3. PostgreSQL clean install、全历史 upgrade 和 backup/restore 全演练。
4. Temporal 大规模 duplicate/replay/worker failover。
5. DataForSEO 正式账单周期与本地 Ledger 对账。
6. Gmail `acceptance_unknown`、Provider 大面积故障和长期恢复演练。
7. 公网部署、正式域名、生产 OAuth verification 和发布审批。

这些项目可以影响正式发布，但不反向否定当前真实本地产品 Gate。

## 本轮关键修复

1. DataForSEO 改为合法 Secret Reference 动态复用、官方 v3 endpoint、可配置调用上限和统一预算字段。
2. 修复 DataForSEO quota 边界，避免最后一个允许调用被 off-by-one 拒绝。
3. 启动脚本按显式 Enable 同步实际项目数据库 Kill Switch，并输出非敏感 Provider 治理状态。
4. 修复 Core 综合 Gate 中过期的 migration、contact evidence、placement evidence 测试数据。
5. 同步 Frontend E2E 到当前 generated contract，并修复联系人选择控件的键盘可访问名称。
6. 生产本地运行改为 Browser Provider 可选，继续复用共享 Browser Worker。
7. 为实际 Website Project 幂等初始化 settings 和 retention，修复真实设置接口 `500`。

未执行 Git commit/push，未撤销用户改动，未使用 mock/fixture 伪装真实运行。

## 结论

`PASS_LOCAL_FUNCTION`

LOCAL-REAL-003..007 的真实 Backlinks 能力已通过集中代码、数据库、Temporal、隔离、安全、治理和
真实浏览器 Gate；当前 ElephTV Website Project 可继续进入 LOCAL-REAL-009 最终本地产品 Gate。
