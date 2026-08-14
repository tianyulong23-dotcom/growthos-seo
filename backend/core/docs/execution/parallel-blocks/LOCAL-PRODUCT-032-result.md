# LOCAL-PRODUCT-032 单次操作、后台完成、前端一次展示结果

- 执行日期：`2026-08-10`（星期一）
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-032`
- 最终状态：`PASS`
- Stop boundary：未执行 `LOCAL-PRODUCT-033`

## 1. 结论

Recommendation Workspace 现在以当前 Website Project 的服务端
Recommendation Inventory、Refill Job、Commercial Discovery Batch 和 Contact
Batch 为唯一运行态事实源。

用户首次操作显示“生成推荐”；已有历史且无活动批次时显示“补充推荐”；存在活动
Job、发现批次或联系人批次时显示“连接当前批次”。活动状态下不会再次提交补货
命令。

页面刷新、路由返回或前端重启后，会先读取当前项目服务端 inventory，再连接同一
Job/Batch。轮询不再使用 Session Storage 或 60 秒本地截止时间，而是顺序执行并
使用最长 15 秒的有界退避，直到服务端终态。

联系人 Job 全部终态且批次汇总完成后，推荐列表只自动刷新一次。用户无需点击
“重新读取”才能看到本批全部合格网站。

本轮复用现有 Provider、Recommendation Refill、Contact Batch、Temporal、
Task Queue、Worker 和 PostgreSQL 业务事实，没有创建第二套 Provider、Queue、
Worker、Workflow、Crawler 或业务状态机。

## 2. 服务端事实源

Recommendation Inventory 新增并通过 OpenAPI 暴露：

- `recommendationContextVersionId`
- `serverUpdatedAt`
- `refillJob.id`
- `refillJob.workflowId`
- `refillJob.status`
- `refillJob.step`
- `refillJob.progress`
- `refillJob.errorCode`
- `refillJob.errorMessage`
- `refillJob.retryCount`
- `refillJob.startedAt`
- `refillJob.finishedAt`
- `refillJob.updatedAt`
- `contactBatch` 真实终态与汇总计数

`serverUpdatedAt` 由当前 Context、Recommendation、Refill Job、发现批次和
Contact Batch 的最新服务端时间共同计算。前端显示的阶段、已耗时、原始候选数、
联系人终态数和最后更新时间均来自该服务端事实，不使用本地假进度。

## 3. 单任务与重复命令防护

现有 Recommendation Refill 命令增加当前 Workspace、Website Project 和
Context 范围的事务 advisory lock。

创建新 Job 前会拒绝以下任一活动事实：

- 状态为 `queued`、`running` 或 `waiting_provider` 的 Refill Job；
- 状态为 `running` 的 Commercial Discovery Batch；
- 状态为 `running` 的 Contact Batch。

前端也保持单飞：

- POST 进行中不会再次 POST；
- 服务端返回 `409` 时改为重新读取并连接现有批次；
- 活动按钮只连接当前批次；
- 页面 GET、刷新、路由恢复和“重新读取”不会启动 DataForSEO。

## 4. 有界轮询与终态刷新

新增独立轮询控制器，读取间隔为：

```text
1.5s -> 2.5s -> 4s -> 6.5s -> 10s -> 15s
```

达到 15 秒后保持上限，不高频空转。每次请求完成后才安排下一次请求，同一时刻
最多一个 inventory GET；暂时性读取失败继续按退避重试，不创建 Provider 请求。

以下任一服务端事实仍为活动时继续跟踪：

- Refill Job 非终态；
- `refillInFlight=true`；
- `refillState=running`；
- `refillState=waiting_contact`；
- Contact Batch 为 `running`。

只有服务端进入终态后才停止轮询，并且推荐列表的终态刷新回调最多执行一次。

## 5. 前端产品体验

运行中页面持续显示：

- 当前真实阶段；
- 已耗时；
- 原始候选数；
- 联系人终态数；
- 服务端最后更新时间；
- 当前 Job、发现批次或 Contact Batch 标识；
- 补货层级、轮次、已尝试层级和淘汰原因。

失败或部分完成时，页面保留已经发布的推荐，并显示可理解的失败阶段、错误信息和
服务端允许的重试操作。不会用“前台等待已结束”掩盖仍在运行的后台任务。

推荐列表继续显示 `LOCAL-PRODUCT-030` 合同中的：

- 综合适合度、匹配层级和匹配理由；
- 匹配产品、主题、关键词、目标页面和受众；
- 目标市场、语言与同语种扩展标识；
- 推荐合作角度；
- DataForSEO Rank、流量、Backlinks、Referring Domains 和风险；
- 相关内容页、SafeFetch 证据和联系人公开来源。

“加入 Opportunity”成功后仍停留在推荐页面，只更新当前行状态和无障碍播报。
Opportunity 由用户主动打开，不自动创建草稿。

## 6. 验收映射

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 新项目点击一次后自动显示终态推荐 | PASS | 明确 POST 一次；服务端终态触发一次推荐列表刷新 |
| 超过 60 秒仍持续跟踪 | PASS | 轮询测试让同一批次运行超过 60 秒，仍继续读取并最终收口 |
| 刷新、路由返回和前端重启恢复同一批次 | PASS | Hook 挂载先读 server inventory，再按 Job/Batch 活动事实重连 |
| 无重复 Provider、Contact Job 或 Recommendation | PASS | 前端单飞、409 重连、后端 advisory lock 和三类活动事实防护 |
| Desktop 操作 | PASS | Playwright 完成生成、等待、终态自动展示和推荐证据查看 |
| 390px 操作 | PASS | Playwright mobile 390px 完成同一生成与自动展示流程 |
| 键盘操作 | PASS | Playwright 键盘加入 Opportunity，路由仍停留 recommendations |

## 7. 定向验证

### 7.1 Backlinks Core

```text
npm run typecheck: PASS
targeted ESLint: PASS
Vitest API: 2 files passed, 6 tests passed
npm run build: PASS
npm run openapi:backlinks:check: PASS, 70 paths
```

API 测试覆盖 server Job/Batch inventory 合同、活动 Refill Job 防重复、活动发现
批次防重复和活动 Contact Batch 防重复。

### 7.2 FastAPI、共享合同与 generated client

```text
Backlinks generated client check: PASS, 71 operations
Platform generated client check: PASS, 6 operations
shared contract check: PASS, 90 public paths / 96 operations
```

### 7.3 Frontend

```text
npm run typecheck: PASS
targeted ESLint: PASS
source and polling tests: 5 passed
npm run build: PASS
Playwright desktop generation: PASS
Playwright mobile 390px generation: PASS
Playwright keyboard Opportunity flow: PASS
```

轮询测试明确验证同一服务端批次超过 60 秒、最大并发 GET 为 1、终态回调只执行
一次、退避上限为 15 秒，以及 Contact Batch 运行中仍属于同一活动批次。

未执行只允许在 `LOCAL-PRODUCT-033` 执行的全量 Backlinks Gate。

## 8. 运行态证据

最终单实例状态：

```text
checkedAt=2026-08-10T14:32:59+08:00
status=ok
runtimeMode=LOCAL_PRODUCT
runId=20260810-143144
projectKey=elephtv
Frontend HTTP=200
FastAPI HTTP=200
Private Core HTTP=200
PostgreSQL 18=healthy
Backlinks migration head=0055
Temporal=healthy
Temporal namespace ready=true
Core API Node count=1
Worker Node count=1
Frontend 5173 Node count=1
```

FastAPI 使用启动包装 Python 和实际解释器组成一条父子进程链，不是第二个
Gateway。最终不存在重复 Worker 或重复应用监听。

运行复验期间发现同一分钟存在两个外部启动调用；已使用项目停止脚本和经过
命令行核验的精确 PID 清理旧组。最终保留的 `20260810-143144` 只有一组 Core、
Worker、FastAPI 和 Frontend。

Gateway Recommendation Inventory 只读请求返回 `HTTP 200`：

```text
recommendationContextVersionId=809026e5-5e9e-4bd7-a8aa-57a4e472d35a
serverUpdatedAt=2026-08-10T05:07:27.791Z
rawCandidateCount=0
publishedContactReadyCount=0
refillInFlight=false
refillState=paused
terminationReason=BUDGET
refillJob.status=success
refillJob.step=ready_inventory_stored
refillJob.progress=100
contactBatch.status=completed
contactBatch.totalJobCount=62
contactBatch.terminalJobCount=62
contactBatch.publishedCount=0
contactBatch.unpublishedCount=62
```

当前预算不足以启动下一次估算为 `27,600 micros` 的 DataForSEO 调用，因此
服务端正确保留历史结果并返回 `BUDGET`，没有伪造推荐或无限等待。

## 9. Provider 安全

启动、重连、状态读取和 Recommendation Inventory GET 前后：

```text
Provider Batch count=17
latest Provider Batch=2026-08-10 01:10:27.160676 UTC
Provider Request count=87
latest Provider Request=2026-08-10 01:10:27.160676 UTC
Provider Usage Ledger count=84
latest Usage Ledger=2026-08-10 01:10:27.185072 UTC
DATAFORSEO_MAX_PAID_CALLS=250
DataForSEO budget limit=1,000,000 micros
spent=974,052 micros
reserved=0
remaining=25,948 micros
```

三张表的数量和最新时间均未变化。本轮没有发起真实 DataForSEO 或 AI 调用，
没有修改预算上限、Kill Switch、历史 Ledger 或 Gmail 人工确认边界。

## 10. 停止

`LOCAL-PRODUCT-032` 已完成并写入本 Result。未执行
`LOCAL-PRODUCT-033`，未重写 `LOCAL-PRODUCT-000..031`，未 commit，未 push。
当前分支仍为 `外链part`，HEAD 仍为
`d796989207cd7dfdec4c0a3fdbc46f855bf0fff9`。
