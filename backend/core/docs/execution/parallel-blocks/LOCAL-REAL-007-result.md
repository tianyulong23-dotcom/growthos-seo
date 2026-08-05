# LOCAL-REAL-007 执行结果

- 执行日期：2026-08-04
- 状态：`PASS_LOCAL_FUNCTION`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- Website Project：`elephtv`
- Project ID：`e0bfde33-54bd-454a-ab61-cf7a4a48dcf0`
- Workspace ID：`cec65d3f-92e5-4b13-aa26-7b39e74e213a`

> 本机时区为 Asia/Shanghai，因此 UI 和本地启动目录显示 2026-08-05；对应的 UTC 业务执行日期为 2026-08-04。

## A. 真实 Placement 建立

复用现有手工/CSV 候选、初始验证和 Placement 能力，没有新建第二套业务权威或队列。Opportunity 保持可选。

- Source：`https://elephtv.africa/`
- Target：`https://elephtv.com/become-an-elephtv-reseller/`
- Candidate ID：`03b0acdf-8b97-41ba-b004-5336bed3a1a5`
- Placement ID：`6fdfa083-1f8e-57d0-bbb8-3498e0bb32c9`
- Initial validation：`VALID`
- Placement：`active`
- Monitoring：`enabled`
- KPI：`true`
- Opportunity：未绑定
- 当前 Placement version：`3`

数据库继续使用 `(website_project_id, normalized_source_url_hash, normalized_target_url_hash)` 唯一约束，防止同一项目内重复 source/target Placement。

## B. 真实页面验证

共享 SafeFetch/Undici + Cheerio 直接读取真实 Source，未使用 mock/fixture。最新 Observation：

- Observation ID：`9b7e863c-e63a-47c0-a340-5923c968c74a`
- Monitor run ID：`1f730bd4-63ab-41c7-8883-4eb7cf1312cd`
- 结果：`present`
- 执行模式：`static`
- Fetch mode：`safe_fetch_static`
- Source HTTP：`200`
- Final source URL：`https://elephtv.africa/`
- Redirects：`0`
- Canonical：`https://elephtv.africa/`
- Robots：允许 index/follow
- noindex：`false`
- Link occurrences：`1`
- Anchor：`https://elephtv.com/become-an-elephtv-reseller/`
- rel：空
- nofollow / sponsored / ugc：均为 `false`
- Evidence hash：`17027fc4f602c703231c97b4ed779db2aa0345af2e8d1f2893278d8adae9810a`
- Occurrence hash：`eec771d29a7e9322e013c24c00544ec94ced489d2b1ae831ed7e5d49e54e3fbb`

每次检查追加不可变 Observation；本次 Observation 中保存一个完整 occurrence 快照。动态页面仍复用仓库现有 Browser Worker/Playwright Adapter，不新增 Worker 或 Queue。

## C. 即时复验与周期监控

前端发起真实“重新验证”后，Core 返回 `202 Accepted`，Temporal workflow 完成：

- Workflow ID：`backlinks:cec65d3f-92e5-4b13-aa26-7b39e74e213a:e0bfde33-54bd-454a-ab61-cf7a4a48dcf0:placement-monitoring:v1:1f730bd4-63ab-41c7-8883-4eb7cf1312cd`
- Temporal run ID：`019fcf19-ac09-77c1-b54b-e7ffad95b8af`
- 运行状态：`SUCCEEDED`
- 开始：`2026-08-04T23:26:33.984Z`
- 完成：`2026-08-04T23:26:35.624Z`

周期策略已注册并计算下一次检查：

- Normal interval：`86400` 秒
- Suspected interval：`3600` 秒
- Jitter ceiling：`3600` 秒
- Browser fallback：`true`
- Next check：`2026-08-05T23:49:06.624Z`

状态机继续保留 suspected 后再确认丢失/变化，以及 recovered/restored 的既有规则；单次网络或解析不确定性不会直接确认链接丢失。

## D. 本轮修复

1. Temporal monitoring workflow 接收 JSON 序列化后的日期字符串时，先统一恢复为 `Date`，避免日期计算和 Repository 调用失败。
2. Placement reverify 的 Postgres JSONB 时间值可能为 `+00:00` 格式；命令响应统一转换为 ISO `Z` 格式，修复事务已经成功但 Fastify response schema 返回 `500` 的问题。
3. 相同 idempotency key 重放返回 `202`、`replayed=true`，未生成重复监控任务。

## E. UI、测试与运行验证

真实 UI 地址：

`http://localhost:5173/projects/elephtv/performance/links`

页面已显示：

- source/target、规范化 URL、anchor、rel 和链接 flags
- Placement lifecycle、KPI、Opportunity 绑定状态
- 初始验证、最新 Observation、HTTP 状态和不可变证据 hash
- 最近检查、连续异常数、下次监控、Browser fallback
- Temporal 任务状态和重新验证结果

截图：`frontend/output/playwright/local-real-007-links.png`

改动相关验证：

- Core monitoring/reverify/API tests：`4` files，`18` tests passed
- Frontend links source tests：`5/5 passed`
- Core typecheck：passed
- Core build：passed
- Frontend typecheck：passed
- Frontend build：passed
- `git diff --check`：无空白错误

本地真实栈：

- 启动 run ID：`20260805-072523`
- Gateway：`7200`
- Core：`7301`
- Frontend：`5173`
- Postgres：`55432`
- Temporal：`57233`
- Browser Worker：`59090`
- Backlinks migration head：`0040`
- 服务与监听状态：healthy

## 说明

- 本轮真实链接是 ElephTV 相关域名之间的公开运营链接，可证明本地产品闭环；它不是独立第三方编辑型外链。
- 一个修复前失败的旧 Candidate 仍保留为 `PENDING` 且 `countsTowardKpi=false`，未删除或伪造历史。
- LOCAL-REAL-007 不要求 Gold Set、正式发布审计、公网域名或 canary 配置。
- 当前无需用户提供外部凭据、登录动作、收件人回复或新的 source/target。

## 结论

`PASS_LOCAL_FUNCTION`

当前真实 Website Project 已在本地完成：真实链接建立、直接网页验证、Placement 持久化、不可变 Observation、即时复验、Temporal 周期调度和前端可见闭环。
