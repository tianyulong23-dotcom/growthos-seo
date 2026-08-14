# LOCAL-PRODUCT-034-RUNTIME-HANDOFF Result

## Task Start Card

- 执行日期：`2026-08-11`
- 精确任务：`LOCAL-PRODUCT-034-RUNTIME-HANDOFF`
- 权威手册：
  `C:\Users\DELL\Documents\缝合\GrowthOS-本地真实外链产品033后推荐池稳定化与任意新项目闭环分步Coding指令-V2.1-2026-08-11.md`
- 上游结果：
  `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-034-result.md`
- 强制监督：
  `C:\Users\DELL\.codex\skills\growthos-scope-gated-execution\SKILL.md`
- 本任务结果：
  `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-034-runtime-handoff-result.md`
- 允许修改：
  本地运行启动/重启脚本、Worker bootstrap、运行状态检查及对应定向测试。
- 运行时目标：
  使用 expected Build ID 启动新 API 和显式 `quiesced` Worker；Worker 加载生产配置并
  验证 PostgreSQL/Temporal，但不启动任何业务消费者、扫描器、Temporal task polling
  或 Provider/Gmail 路径。
- 真实外部调用上限：
  `DataForSEO=0 calls/0 micros`、`AI=0`、`Gmail Send=0`、
  `Gmail Sync=0`、`Browser=0`。
- Canonical 业务数据修改上限：`0`。
- 必须保持的配置：
  `DATAFORSEO_ABSOLUTE_BUDGET_MICROS=1000000`、
  `DATAFORSEO_MAX_PAID_CALLS=250`、Gmail Send/Sync 均保持启用；
  DataForSEO 与 Gmail 控制继续相互独立。
- 定向验证：
  quiesced 不启动业务消费者、quiesced Build/infra readiness、normal 路径回归、
  非 `LOCAL_PRODUCT` fail-closed、未配置模式保持原语义、状态脚本维护态合同。
- 全量 Gate：未授权。
- Git：不得 commit、push、创建或切换分支。
- 显式停止点：
  写完本结果并给出 `handoffReadyFor035` 后立即停止；不得启动
  `LOCAL-PRODUCT-035`、不得消费 waiting Job/pending outbox、不得恢复 normal Worker。

## Checkpoints

1. `CP1` 只读部署前审计与阻塞条件判断。
2. `CP2` 显式 quiesced Worker 模式及状态合同。
3. `CP3` 定向测试与正常模式回归。
4. `CP4` 静默重启、前后零副作用对比及 Build/基础设施验收。

当前状态：`TESTED`

`handoffReadyFor035=true`

## 实现结果

新增显式启动模式：

```text
BACKLINKS_WORKER_EXECUTION_MODE=quiesced
```

该模式仅允许在 `BACKLINKS_RUNTIME_MODE=LOCAL_PRODUCT` 下启动。未配置时仍为
`normal`；非法模式和非 `LOCAL_PRODUCT` 的 quiesced 请求均 fail closed。

quiesced Worker：

- 加载与 normal Worker 相同的 production runtime module，并执行
  `createWorkerRegistrations(...)` 完成真实 composition 校验。
- 使用现有 Worker 数据库角色检查 PostgreSQL 18、RLS 角色、关键表和连接。
- 使用 Temporal Client 检查 Server connectivity 和
  `growthos-backlinks-canary` namespace。
- 输出 Build ID、执行模式、业务消费者状态和基础设施 readiness。
- 保持进程存活，并在 `SIGINT`、`SIGTERM` 或 Windows `SIGBREAK` 时关闭
  runtime、PostgreSQL pool 和 Temporal Client。
- 不调用 `startBacklinksWorker`、`worker.run`，不启动 Temporal task polling。
- 不启动 outbox relay、Recommendation Inventory scan、Project Analysis/
  Refill outbox consumer、Gmail Send/Sync、Profile Sync、Placement Monitoring
  或其他后台轮询器。

normal Worker 仍使用原有 `node dist/index.js worker` 路径；没有增加 Task Queue，
也没有建立第二套 Worker 架构。

maintenance 启动只拉起新 Core API 和 quiesced Worker。FastAPI、frontend 和
Browser Worker 在该模式下保持停止，避免把维护态误报为正常业务运行态。

## 修改文件

- `backend/core/scripts/local-product-quiesced-worker.mjs`
- `backend/core/test/unit/local-product-quiesced-worker.test.ts`
- `ops/local-product/Set-LocalProductConfiguration.ps1`
- `ops/local-product/Invoke-LocalProductProcess.ps1`
- `ops/local-product/Start-GrowthOS-LocalProduct.ps1`
- `ops/local-product/Status-GrowthOS-LocalProduct.ps1`
- `ops/local-product/Restart-GrowthOS-LocalProduct.ps1`
- `Start-GrowthOS-LocalProduct.ps1`
- `Restart-GrowthOS-LocalProduct.ps1`
- `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-034-runtime-handoff-result.md`

仓库在本任务开始前已有大量未提交修改；本任务没有清理、回退或覆盖无关修改。

## 定向测试

```text
npm.cmd exec -- vitest run \
  test/unit/local-product-quiesced-worker.test.ts \
  test/unit/local-product-process-scripts.test.ts

结果：2 test files passed，22 tests passed
```

覆盖：

- quiesced 不调用正式 Worker 启动函数或后台消费者。
- quiesced 输出 Build/PostgreSQL/Temporal readiness。
- quiesced 仅允许 `LOCAL_PRODUCT`。
- 未配置模式默认 `normal`。
- normal 模式保留 `dist/index.js worker`。
- 状态脚本输出 maintenance 合同。
- quiesced 进程保活和 graceful shutdown 清理。

其他检查：

```text
node --check scripts/local-product-quiesced-worker.mjs
结果：PASS

eslint scripts/local-product-quiesced-worker.mjs \
  test/unit/local-product-quiesced-worker.test.ts
结果：PASS

PowerShell parser 检查全部修改的 .ps1
结果：PASS

npm.cmd run local-product:build-identity:check
结果：PASS
buildId=local-product-2337ef16419c97c3e86628d1
```

第一次维护启动时，Worker 输出 readiness 后因未决 Promise 本身不保持 Node
event loop 而退出。加入可清理保活 timer 后重新运行上述测试并重新启动；最终 Worker
跨过完整 60 秒保活周期后仍在运行。该中间失败没有启动业务消费者，也没有改变下面
记录的业务或 Provider 状态。

## 部署前只读审计

审计使用 PostgreSQL `BEGIN READ ONLY`、Temporal CLI、Docker health 和现有
Status，不执行数据库写入。

阻塞条件结果：

```text
active provider request=0
active provider batch request=0
active provider lease=0
active provider budget reservation=0
active batch provider task ID=0
active batch actual cost micros=0
unlinked actual-cost ledger row=0
duplicate active idempotency Workflow=0
```

Provider usage ledger 为历史 `settled=172`、`released=2`；不存在 active
`reserved` 记录。现有唯一 Running Temporal Workflow 是：

```text
workflowType=backlinksGmailPollingSyncV1Workflow
workflowId=
  backlinks:11111111-1111-4111-8111-111111111111:
  cec65d3f-92e5-4b13-aa26-7b39e74e213a:
  gmail-connection:gmail-polling-sync:v1:
  ce7b81a9-9023-4a0b-a1ba-371dca9fc737
runId=67575737-7b1a-43d2-9145-df47688c6c5b
```

现有任务事实：

```text
Recommendation Refill Job
  id=36e44372-c101-485a-bcca-5ec9811bcdbd
  status=waiting_provider
  step=provider_request_authorizing
  progress=10
  retryCount=0

Commercial Discovery Batch
  id=fe1ef5f3-40ea-4711-b3fe-80bfe1158d5a
  status=running
  paidCostMicros=0
  idempotencyKey=commercial-discovery:98089a96-e3da-47a1-ad5f-f655c63886c5

Project Analysis Outbox
  id=6bdd8799-a8ee-4983-909b-564edbf0bed0
  status=pending
  attemptCount=0
  claimedAt=<null>
  publishedAt=<null>
  idempotencyKey=project-analysis:1
```

没有发现要求返回 `BLOCKED` 的条件。

## 启动与 Build 证据

最终维护启动：

```text
runId=20260811-120539
runtimeMode=LOCAL_PRODUCT
workerExecutionMode=quiesced
businessConsumersRunning=false
```

`Status-GrowthOS-LocalProduct.ps1 -Json` 于
`2026-08-11T12:07:41.1311992+08:00` 返回：

```text
status=maintenance_ready
build.matches=true

expected Build ID=
  local-product-2337ef16419c97c3e86628d1
configured API Build ID=
  local-product-2337ef16419c97c3e86628d1
configured Worker Build ID=
  local-product-2337ef16419c97c3e86628d1
running API Build ID=
  local-product-2337ef16419c97c3e86628d1
running Worker Build ID=
  local-product-2337ef16419c97c3e86628d1

postgresReady=true
PostgreSQL health=healthy
PostgreSQL version=18.4

temporalReady=true
Temporal health=healthy
namespace=growthos-backlinks-canary
namespaceReady=true
```

Worker readiness log：

```json
{
  "event": "backlinks.worker.ready",
  "buildId": "local-product-2337ef16419c97c3e86628d1",
  "workerExecutionMode": "quiesced",
  "businessConsumersRunning": false,
  "postgresReady": true,
  "postgresVersion": "18.4 (Debian 18.4-1.pgdg12+1)",
  "temporalReady": true,
  "namespaceReady": true
}
```

进程命令为：

```text
node scripts/local-product-quiesced-worker.mjs
```

Temporal Task Queue 只读检查：

```text
workflow pollers=null
activity pollers=null
workflow tasksDispatchRate=0
activity tasksDispatchRate=0
```

因此该进程是维护态 Worker 身份/基础设施检查进程，不是正常业务运行 Worker。

## Provider/Gmail 零调用证据

部署前后只读对比：

| 事实 | 部署前 | 部署后 |
| --- | ---: | ---: |
| DataForSEO limit micros | 1000000 | 1000000 |
| DataForSEO spent micros | 950976 | 950976 |
| DataForSEO reserved micros | 0 | 0 |
| DataForSEO remaining micros | 49024 | 49024 |
| Provider request total | 177 | 177 |
| Active Provider request | 0 | 0 |
| Provider batch request total | 91 | 91 |
| Active Provider batch request | 0 | 0 |
| Active Provider lease | 0 | 0 |
| Provider usage ledger total | 174 | 174 |
| Provider actual cost micros | 3030768 | 3030768 |
| Recommendation Refill total | 67 | 67 |
| Commercial Discovery Batch total | 19 | 19 |
| Pending outbox total | 1 | 1 |
| Gmail send intent total | 2 | 2 |
| Gmail send attempt total | 2 | 2 |
| Gmail provider-accepted attempt total | 2 | 2 |
| Running Temporal Workflow total | 1 | 1 |

指定 Job、Batch 和 Outbox 的 status、step/progress、cost、attempt count、
claimed/published time、updated time 和 idempotency key 均未变化。唯一 Running
Workflow 的 Workflow ID 和 Run ID 也未变化。

配置保持：

```text
DataForSEO enabled=true
absoluteBudgetMicros=1000000
DATAFORSEO_MAX_PAID_CALLS=250
Gmail Send enabled=true
Gmail Sync enabled=true
DataForSEO 与 Gmail 控制仍分别报告、相互独立
```

本任务没有 DataForSEO、AI、Gmail 或 Browser Provider 调用，没有邮件发送或同步，
没有新增 Provider request/lease、Recommendation Refill Job、Commercial Discovery
Batch、Outbox 或 Temporal Workflow。

## 最小 Smoke

只执行无副作用 readiness/status 检查：

```text
GET http://127.0.0.1:7301/ready
statusCode=200
buildId=local-product-2337ef16419c97c3e86628d1

Status-GrowthOS-LocalProduct.ps1 -Json
status=maintenance_ready
```

没有启动推荐补货、重评、邮件发送、邮件同步或真实 Provider 验收。

## 最终状态与停止点

```text
status=TESTED
handoffReadyFor035=true
REAL_PROVIDER_VERIFIED=false
workerExecutionMode=quiesced
businessConsumersRunning=false
LOCAL-PRODUCT-035 started=false
commit=false
push=false
```

`handoffReadyFor035=true` 仅表示 LOCAL-PRODUCT-035 的 Build ID 与基础设施前置条件
已在 quiesced 模式满足。quiesced Worker 未被声明为正常业务运行 Worker。

到达显式停止点后保持当前新 API 和 quiesced Worker；不恢复 normal Worker，不处理
`waiting_provider` Job，不消费 pending outbox，不启动 `LOCAL-PRODUCT-035`。
