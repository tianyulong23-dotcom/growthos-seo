# LOCAL-PRODUCT-010 Draft Job 持续轮询与刷新恢复

- 执行日期：`2026-08-05`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-010`
- 状态：`PASS`
- 最终本地运行 ID：`20260805-120557`

## 1. 结论

生成邮件草稿页面已从单次查询改为同一 Draft Job 的持续串行轮询。页面刷新后会按
`project + opportunity + logicalDraftKey` 查询并恢复已有任务，不会创建第二个 Job，也不会
再次调用 AI。任务成功后，前端只使用最新 Job 响应中的 `draftId` 打开真实草稿。

页面现在显示真实阶段、已耗时、最后成功查询时间、查询次数、排队耗时、Provider 耗时、
持久化耗时和前端发现耗时。失败、拒绝和服务端 deadline 到期会停止轮询；只有用户显式点击
重新生成才会使用新的幂等键创建任务。

本轮没有修改 Opportunity 业务状态，没有生成浏览器伪造草稿，没有批准或发送 Gmail 邮件。

## 2. 实现范围

### 前端

- 新增独立 Draft Job 轮询器，固定间隔 `1.5s`，直到 `SUCCEEDED`、`FAILED`、`REFUSED`、
  服务端 deadline 到期、页面卸载或 Project/Opportunity 切换。
- 每个轮询请求携带 `AbortSignal`；切换上下文和卸载时立即终止。
- 同一个 Job 同时最多一个状态 GET，不使用并发定时器。
- 创建请求有并发保护；轮询器只执行 GET，不能创建 Draft Job。
- 页面刷新时调用 latest API 恢复已有 Job，并继续轮询同一个 Job。
- 成功后从最新 Job 响应读取 `draftId`，及时进入草稿审核页。
- 增加真实阶段、已耗时、最后成功查询时间、轮询次数和分段耗时展示。

### Core、Gateway 与契约

- Draft Job 查询返回 `queuedAt`、`startedAt`、`finishedAt`、`latencyMs`、
  `queueWaitLatencyMs`、`providerLatencyMs`、`persistenceLatencyMs`、
  `attemptCount`、`lastErrorCategory` 和 `deadlineAt`。
- `startedAt` 使用任务实际 claim 时间，`finishedAt` 使用实际完成/失败时间。
- 新增按 Opportunity 和 logical draft key 获取最新 Job 的 Project-scoped API。
- FastAPI Gateway、共享 OpenAPI 和前端 generated client 已同步。
- 服务端 deadline 由 Job 排队时间计算；到期只停止前端等待，不自动创建任务或调用 AI。

## 3. 零 AI 调用恢复验证

使用 `currentaffairsza.com` 已成功任务验证：

| 项目 | 结果 |
| --- | --- |
| Opportunity | `4f459ee6-78a9-4c8a-940b-50c45ef547aa` |
| 恢复的 Job | `c0780fd9-b4e6-45ec-90b7-3dc1ef622564` |
| 恢复的 Draft | `04d65701-2dec-4f7d-9630-a8fe75bd6192` |
| Job 状态 | `SUCCEEDED` |
| 创建 Draft Job POST | `0` |
| 新增 AI 调用 | `0` |
| latest GET | `2`，刷新前后各一次 |
| 独立 Job status GET | `0`，latest 已返回终态 |
| 刷新后进入原 Draft | `509ms` |

刷新前故意延迟首次 latest 请求，然后在请求未完成时刷新。刷新后页面恢复相同 Job 和 Draft，
没有创建新 Job，Project 的 Model Run 数仍为 `3`，SendIntent/SendAttempt 仍为 `0/0`。

该历史任务创建于本次时间字段修正之前，所以旧记录的创建、开始和结束时间相同；它仅用于证明
零 AI 恢复。新任务的真实活动时间由下面的最终验收证明。

## 4. 最终一次真实 AI 验收

目标站点：`dstvproinstallation.co.za`

| 项目 | 实测结果 |
| --- | --- |
| Opportunity | `6c2d65ea-c9f6-4d0c-bb26-ef2204274d0d` |
| Contact | `45517210-0eaa-4412-94f8-6cb9f51c3dc8` |
| 新 Draft Job | `3f15ffea-6b77-4e4e-988f-7f3351590253` |
| 新 Draft | `aaeae74d-b9e8-4452-8535-10b7bf3b94e1` |
| 创建 POST | `1` |
| AI 调用次数 | `1` |
| Provider / Model | `openai / gpt-5.6-sol` |
| latest GET | `2` |
| Job status GET | `6` |
| 状态序列 | `RUNNING x5 -> SUCCEEDED` |
| 最大并发状态 GET | `1` |
| 刷新后恢复 | 相同 Job，未重复创建 |
| 刷新到草稿 | `9.541s` |
| 点击生成到草稿 | `9.759s` |

创建接口返回 `QUEUED` 后立即刷新页面。刷新后的 latest API 返回同一个 Job，随后对该 Job
持续串行轮询，最终读取服务端返回的 Draft ID 并进入草稿页。

### 实际耗时

| 阶段 | 实测耗时 |
| --- | --- |
| 排队等待 | `314ms` |
| Provider | `9,204ms` |
| 持久化 | `12ms` |
| 服务端实际生成总耗时 | `9,577ms` |
| 前端发现终态 | 约 `79ms` |
| 浏览器点击到草稿 | `9,759ms` |

服务端时间：

- `created_at`: `2026-08-05 04:10:39.750+00`
- `started_at`: `2026-08-05 04:10:40.064086+00`
- `finished_at`: `2026-08-05 04:10:49.326767+00`

终态响应于 `2026-08-05T04:10:49.406Z` 被浏览器收到，因此前端发现耗时约为 `79ms`。

### 无重复和业务边界证明

- Project Model Run：`3 -> 4`，只增加 `1`。
- Draft：`2 -> 3`，只增加 `1`。
- DraftVersion：`3 -> 4`，只增加 `1`。
- 新 Job `attempt_count = 1`，无第二次 Provider 尝试。
- 创建 Draft Job POST 为 `1`，状态轮询没有 POST。
- Opportunity 保持 `JOINED | ACTIVE | OPEN`。
- SendIntent/SendAttempt 保持 `0/0`，浏览器发送 POST 为 `0`。

## 5. 测试结果

| 验证 | 结果 |
| --- | --- |
| 前端 ESLint | passed |
| 前端 TypeScript typecheck | passed |
| 前端 production build | passed |
| Draft 轮询与服务端来源 Node tests | `6/6 passed` |
| 重复 `RUNNING` 后继续轮询测试 | passed；3 次 GET，最大并发 1 |
| Abort 与 deadline 测试 | passed |
| 定向 Playwright Draft 生成/刷新恢复 | `1/1 passed` |
| Core lint | passed |
| Core typecheck | passed |
| Core Draft API/OpenAPI tests | `6/6 passed` |
| PostgreSQL Draft migration integration | `8/8 passed` |
| FastAPI Gateway 与共享契约 pytest | `23 passed` |
| Backlinks OpenAPI 生成检查 | `57 paths` |
| Shared contract 生成检查 | `79 public paths / 85 operations` |
| Frontend generated Backlinks client | `58 operations` |
| `git diff --check` | 无 whitespace error；仅 Windows LF/CRLF 提示 |

执行 `Restart-GrowthOS-LocalProduct.ps1` 后，Frontend `5173`、Gateway `7200`、
Core `7301`、Browser Worker `7401`、PostgreSQL `55432` 和 Temporal `57233`
均通过监听与健康检查，当前运行无最近错误。

## 6. 最终状态

`PASS`

`LOCAL-PRODUCT-010` 的持续轮询、刷新恢复、串行请求、终态导航、真实阶段和耗时展示均已实现并
通过定向测试及真实浏览器验收。最终真实验收只新增一次 AI 调用。

未执行 `LOCAL-PRODUCT-011`、`LOCAL-PRODUCT-012` 或 `LOCAL-PRODUCT-013`，未重新执行
`LOCAL-PRODUCT-003..009`，未执行 Git commit/push。完成后停止，等待用户确认。
