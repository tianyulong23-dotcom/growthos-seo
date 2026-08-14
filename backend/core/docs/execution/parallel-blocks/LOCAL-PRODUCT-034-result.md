# LOCAL-PRODUCT-034 运行时一致性、真实错误和单操作恢复基线结果

- 执行日期：`2026-08-11`（星期二）
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 精确任务 ID：`LOCAL-PRODUCT-034`
- 唯一权威指令：
  `C:\Users\DELL\Documents\缝合\GrowthOS-本地真实外链产品033后推荐池稳定化与任意新项目闭环分步Coding指令-V2.1-2026-08-11.md`
- 强制监督 Skill：
  `C:\Users\DELL\.codex\skills\growthos-scope-gated-execution\SKILL.md`
- 结果路径：
  `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-034-result.md`
- 当前状态：`TESTED`
- 显式停止点：写完本结果后立即停止；不得启动 `LOCAL-PRODUCT-035`

## Start Card

### 任务所有权

本任务只处理：

1. 本地产品构建、启动、重启和状态检查链的 Build Identity 与 stale artifact
   拒绝；
2. Recommendation Refill 的稳定错误合同、恢复类型、Provider 调用事实和脱敏诊断
   ID；
3. 当前项目推荐上下文的服务器签发 single-flight 操作身份，以及刷新、重启、双
   标签页和重复点击时的身份复用；
4. 没有存活 Job、Workflow 或 lease 的孤儿 `running` 状态的幂等 reconcile
   服务或管理命令。

禁止修改：

- 推荐评分、硬门槛、20 站层级或资源补货策略；
- `0057` 或资源库数据；
- 历史 v2 -> v3 重评和旧状态迁移；
- 联系人抓取策略、统一联系人 API 或推荐池体验重做；
- Gmail、Links、Canonical 本地业务数据；
- 第二套 Provider、Queue、Worker、Workflow 或业务状态机。

### 预计修改区域

- `ops/local-product` 和仓库根目录的本地产品 Start/Restart/Status 包装链；
- `backend/core` 的运行时入口、Recommendation Refill
  command/query/workflow/error/reconcile 合同及对应定向测试；
- `backend/contracts/openapi`、FastAPI Gateway 和 generated client 中仅与 034
  新增合同直接相关的机械同步；
- `frontend/src/features/outreach/recommendations` 中仅 operation identity 复用、
  polling 和稳定恢复错误展示及其定向测试；
- 本 Result 文件。

实际修改文件将在每个检查点完成后追加记录。当前工作树包含
`LOCAL-PRODUCT-000..033` 及其他既有未提交改动；本任务不会清理、回退或重写这些
改动。

### Provider 与数据上限

```text
真实 DataForSEO：0 次，0 micros
真实 AI：0 次
真实 Gmail：0 次
真实 Browser：0 次
Canonical 本地业务数据修改：0
允许：fixture、测试数据库、受控本地 Temporal 测试环境
```

### 验证权限

允许：

- Core typecheck/lint；
- Build ID 与 stale artifact 定向测试；
- refill error contract 定向测试；
- single-flight/idempotency/Temporal restart 定向测试；
- 前端 refill polling 与重复点击定向测试；
- reconcile dry-run/apply 幂等定向测试；
- 正常 build 及为 Build Identity 证据所必需的受控本地 restart/status。

禁止执行 `npm run verify:backlinks` 或其他全量 Gate。

### Git 权限

```text
commit：未授权
push：未授权
branch create/switch：未授权
```

### 开始状态

`LOCAL-PRODUCT-033-result.md` 存在，最终状态为
`PASS_CODE_AI_INPUT_REQUIRED`。034 的代码前置满足；AI 缺口不授权本任务调用真实
AI。

开始时只读状态：

```text
branch=外链part
HEAD=d796989207cd7dfdec4c0a3fdbc46f855bf0fff9
runtime status=ok
runId=20260811-100211
projectKey=aiper-com-bb2f985a
Frontend HTTP=200
FastAPI HTTP=200
Private Core HTTP=200
PostgreSQL 18=healthy
Backlinks migration head=0057
Temporal=healthy
Core API running=true
Worker running=true
```

现有状态脚本尚未报告可比较的 expected/running Build ID；Core API ready 日志也未
报告 Build ID。现有 `-SkipBuild` 只跳过 build，没有校验源码与产物指纹。这是 CP1
要固定的首个缺陷：

```text
defectId=LP034-BUILD-001
ownerTask=LOCAL-PRODUCT-034
```

## CP1 Build Identity 与 stale artifact 拒绝

已完成：

- `backend/core` 的 build 现在在 `tsc` 后生成
  `dist/local-product-build-identity.json`，Build ID 由源码指纹生成，并独立记录
  编译产物指纹；实现不依赖 Git clean、branch 或 commit SHA。
- API 与 Worker 启动时读取同一编译清单，并强制
  `TEMPORAL_BUILD_ID == manifest.buildId`，不匹配时以
  `LOCAL_PRODUCT_STALE_BUILD` 拒绝启动。
- Core `/ready`、API/Worker ready 日志、进程 state 和 Status 输出均携带可比较的
  expected/configured/running Build ID。
- Start 和 Restart 的 `-SkipBuild` 在停止当前实例前校验源码、产物与清单；
  指纹不匹配时失败关闭，不启动旧产物。
- normal build 完成后把同一 Build ID 写入 API 与 Worker 环境，再以该 ID 做
  readiness 校验。

定向验证：

```text
npm exec -- vitest run test/unit/local-product-build-identity.test.ts test/unit/local-product-process-scripts.test.ts
PASS: 2 files, 21 tests

npm run typecheck
PASS

PowerShell parser: Start/Restart/Status
PASS

npm run build
PASS
buildId=local-product-2337ef16419c97c3e86628d1
sourceFingerprint=2337ef16419c97c3e86628d171aae0e0b34e952989be952c135673cbe4b69642
artifactFingerprint=11d8e8b209f82ef88e01fb7d5e7ea62b254cea2a963a6843f6b4a908828e6497
builtAt=2026-08-11T03:12:12.822Z

npm run local-product:build-identity:check
PASS: ok=true, code=OK
```

stale source 与 stale artifact 均由临时夹具测试验证为
`LOCAL_PRODUCT_STALE_BUILD`。由于当前真实本地实例启用了 DataForSEO、AI 和
Gmail，且剩余 DataForSEO 预算仅 `49,024 micros`，本检查点未重启该实例，真实
Provider 调用与 Canonical 业务数据修改均为 `0`。

## CP2 稳定错误合同

已完成：

- 新增稳定的 Recommendation Refill 失败合同：
  `rootCause`、`recovery`、`providerCallOccurred`、脱敏 `diagnosticId` 和安全
  `message`。
- 固定根因集合：
  `BUDGET_PAUSED`、`PROVIDER_UNAVAILABLE`、`PROJECT_CONTEXT_REQUIRED`、
  `RECOVERY_CONFLICT`、`STALE_BUILD`、`ORPHAN_OPERATION`、
  `SUPPLY_FLOOR_REACHED`、`UNKNOWN_INTERNAL`。
- 固定恢复集合：
  `RESUME_OPERATION`、`WAIT_PROVIDER`、`COMPLETE_PROJECT_CONTEXT`、
  `RESTART_SERVICE`、`ACCEPT_SUPPLY_FLOOR`、`CONTACT_SUPPORT`。
- Workflow 统一规范化未知异常；Runtime 持久化稳定合同，并从 Provider
  执行事实写入 `providerCallOccurred`，不依赖前端猜测。
- GET Recommendation 状态返回同一稳定失败合同；前端只展示安全消息、诊断 ID
  和对应恢复动作，不泄露密钥、请求头、Provider 原始响应或堆栈。

定向验证：

```text
recommendation-refill-failure.test.ts
recommendation-refill-workflow.test.ts
production-runtime.test.ts
recommendations-route.test.ts
PASS（包含在最终 Core 8 files / 52 tests）
```

## CP3 服务器签发 single-flight 与恢复身份

已完成：

- 客户端不再生成随机 idempotency key、refill window 或业务操作身份。
- 服务器按 Website Project 当前 Recommendation Context 签发并返回
  `operationId`；同一上下文的刷新、双标签页和重复点击复用同一活动操作。
- `operationId` 使用 refill Job 行 UUID；项目级 advisory lock 和行锁约束并发。
- 对未发生付费 Provider 调用且可安全恢复的失败操作，复用同一 Job、Workflow ID
  和 Outbox 记录；不会创建第二个付费批次。
- 前端只把服务器返回的 `operationId` 缓存到项目/上下文范围的
  `localStorage`，随后继续读取服务器状态；React 层另有同步防重复点击锁。
- API/查询合同返回服务器操作身份和稳定失败字段；OpenAPI 与 generated
  Backlinks client 已同步并通过一致性检查。

定向验证：

```text
recommendation-commands-route.test.ts
recommendations-route.test.ts
recommendation-refill-workflow.test.ts
recommendations-source.test.mjs
recommendation-refill-polling.test.mjs
PASS
```

## CP4 孤儿 running 状态 reconcile

已完成：

- 新增通用管理命令：
  `npm run local-product:recommendation-refill:reconcile`。
- 命令只接受结构化 stdin：
  `action=dry-run|apply`、组织/工作区/Website Project scope 和 `actorId`；
  不需要手工 SQL，不包含项目 ID 或域名特判。
- reconcile 在同一数据库事务中持有项目 advisory lock 和 policy 行锁，并在
  apply 前探测 Temporal Workflow 存活状态，避免探测与更新之间的竞争窗口。
- 只有 `refill_state=running` 且没有存活 Job、待启动 Outbox、有效 Provider
  lease 或存活 Temporal Workflow 时才计划
  `RESET_RUNNING_TO_IDLE`。
- Temporal 状态未知时失败关闭；活动 Job、Outbox、lease 或 Workflow 均保持不变。
- dry-run 返回项目数、原因和计划动作且没有 UPDATE；apply 后再次 apply 的修改数
  为 `0`。

定向验证：

```text
recommendation-refill-reconciliation.test.ts
PASS: 6 tests

覆盖：
- dry-run 无副作用
- apply 后第二次 apply 为 0
- 活动 Temporal Workflow 安全
- 活动 Job 安全
- 待启动 Outbox 安全
- 有效 Provider lease 安全
```

本任务没有对真实本地数据库执行 reconcile；上述验证使用受控 fake
transaction/Temporal client，因此 Canonical 本地业务数据修改为 `0`。

## 最终定向验证

```text
npm run lint
PASS

npm run typecheck
PASS

npm run build
PASS

npm run local-product:build-identity:check
PASS: ok=true, code=OK
buildId=local-product-2337ef16419c97c3e86628d1

npm exec -- vitest run \
  test/unit/local-product-build-identity.test.ts \
  test/unit/local-product-process-scripts.test.ts \
  test/unit/recommendation-refill-failure.test.ts \
  test/backlinks/api/recommendation-commands-route.test.ts \
  test/backlinks/api/recommendations-route.test.ts \
  test/backlinks/integration/recommendation-refill-workflow.test.ts \
  test/unit/production-runtime.test.ts \
  test/unit/recommendation-refill-reconciliation.test.ts
PASS: 8 files, 52 tests

node --test recommendations-source.test.mjs recommendation-refill-polling.test.mjs
PASS: 5 tests

npm run openapi:backlinks:check
PASS: 71 paths

npm run check:backlinks-client
PASS: 72 operations

frontend npm run typecheck
PASS
```

遵循任务边界，未运行 `npm run verify:backlinks` 或其他全量 Gate。

## 034 修改文件

以下清单只记录 034 直接新增或编辑的文件；工作树中的其他 000–033 和并发任务
改动不归属本结果：

```text
backend/core/package.json
backend/core/scripts/local-product-build-identity.ts
backend/core/scripts/reconcile-recommendation-refill-orphans.ts
backend/core/src/index.ts
backend/core/src/runtime-build-identity.ts
backend/core/src/modules/backlinks/api/private-server.ts
backend/core/src/modules/backlinks/api/recommendation-commands.route.ts
backend/core/src/modules/backlinks/api/recommendations.route.ts
backend/core/src/modules/backlinks/application/commands/recommendations.command.ts
backend/core/src/modules/backlinks/application/queries/recommendations.query.ts
backend/core/src/modules/backlinks/application/services/recommendation-refill-reconciliation.service.ts
backend/core/src/modules/backlinks/domain/recommendations/refill-failure.ts
backend/core/src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts
backend/core/src/modules/backlinks/runtime/production-runtime.ts
backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.ts
backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.workflow.ts
backend/core/test/backlinks/api/recommendation-commands-route.test.ts
backend/core/test/backlinks/api/recommendations-route.test.ts
backend/core/test/backlinks/integration/recommendation-refill-workflow.test.ts
backend/core/test/unit/local-product-build-identity.test.ts
backend/core/test/unit/local-product-process-scripts.test.ts
backend/core/test/unit/production-runtime.test.ts
backend/core/test/unit/recommendation-refill-failure.test.ts
backend/core/test/unit/recommendation-refill-reconciliation.test.ts
frontend/src/api/generated/backlinks.ts
frontend/src/features/outreach/recommendations/api.ts
frontend/src/features/outreach/recommendations/recommendations-source.test.mjs
frontend/src/features/outreach/recommendations/recommendations-workspace.tsx
frontend/src/features/outreach/recommendations/use-recommendation-refill.ts
ops/local-product/Invoke-LocalProductProcess.ps1
ops/local-product/Restart-GrowthOS-LocalProduct.ps1
ops/local-product/Set-LocalProductConfiguration.ps1
ops/local-product/Start-GrowthOS-LocalProduct.ps1
ops/local-product/Status-GrowthOS-LocalProduct.ps1
backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-034-result.md
```

`local-product-dataforseo-runtime.ts` 的 034 变更仅删除全量 lint 报告的未使用导入，
没有修改 Provider 行为。

## Provider、数据、运行时与 Git 事实

```text
真实 DataForSEO：0 次，0 micros
真实 AI：0 次
真实 Gmail：0 次
真实 Browser：0 次
Canonical 本地业务数据修改：0
当前本地产品 restart：0
commit：0
push：0
branch create/switch：0
```

开始时运行的 `runId=20260811-100211` 未被停止或重启。它仍是任务开始前的运行
实例，因此本结果只证明 034 代码与受控测试达到 `TESTED`，不把未部署的新 Build
ID 声称为当前 live product acceptance。

## 未完成项与停止

- 没有执行真实 Provider 验收，也没有对当前运行实例部署或重启新 Build。
- 没有修改 Canonical 本地业务数据。
- `LOCAL-PRODUCT-034 = TESTED`。
- 已到达显式停止点；`LOCAL-PRODUCT-035` 未启动。

## 运行态交接 Start Card

- 执行日期：`2026-08-11`
- 精确任务：`LOCAL-PRODUCT-034 运行态交接与 LOCAL-PRODUCT-035 前置检查`
- 权威手册：
  `C:\Users\DELL\Documents\缝合\GrowthOS-本地真实外链产品033后推荐池稳定化与任意新项目闭环分步Coding指令-V2.1-2026-08-11.md`
- 强制监督：
  `C:\Users\DELL\.codex\skills\growthos-scope-gated-execution\SKILL.md`
- 唯一结果文件：
  `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-034-result.md`
- 允许操作：只读审计现有 Job、Workflow、Provider lease、Outbox 和发送状态；
  风险清零后使用现有配置正常重启 API、Worker、FastAPI 和前端；执行 Status
  与无副作用最小 smoke。
- 真实 Provider 上限：
  `DataForSEO=0 calls/0 micros`、`AI=0`、`Gmail=0`、`Browser=0`。
- Canonical 本地业务数据修改上限：`0`。
- 配置保持：
  `DATAFORSEO_ABSOLUTE_BUDGET_MICROS=1000000`、
  `DATAFORSEO_MAX_PAID_CALLS=250`、Gmail Send/Sync 均保持启用；DataForSEO
  与 Gmail 控制继续相互独立。
- 全量 Gate：未授权。
- Git：不得 commit、push、创建或切换分支。
- 显式停止点：完成运行态证据与 035 前置判断后立即停止；不得启动
  `LOCAL-PRODUCT-035`。

## 运行态交接预检结果

预检时间：`2026-08-11 11:31:59 +08:00`

只读检查使用 PostgreSQL `BEGIN READ ONLY`、Temporal CLI、Docker health 和
`Status-GrowthOS-LocalProduct.ps1 -Json`。本轮没有创建 Job、Workflow、
Provider request、Provider lease、Send Intent 或 Canonical 业务事实。

### 运行中任务与付费风险

```text
Temporal Running Workflow：
  1 个 backlinksGmailPollingSyncV1Workflow
  workflowId=
    backlinks:11111111-1111-4111-8111-111111111111:
    cec65d3f-92e5-4b13-aa26-7b39e74e213a:
    gmail-connection:gmail-polling-sync:v1:
    ce7b81a9-9023-4a0b-a1ba-371dca9fc737

active Recommendation Refill Job：1
  jobId=36e44372-c101-485a-bcca-5ec9811bcdbd
  status=waiting_provider

running Commercial Discovery Batch：1
  batchId=fe1ef5f3-40ea-4711-b3fe-80bfe1158d5a
  status=running
  paidCostMicros=0

active Reassessment Job：0
active Provider request：0
active Provider lease：0
active Send Intent：0

pending Outbox：1
  eventType=backlinks.project-analysis.requested.v1
  eventId=6bdd8799-a8ee-4983-909b-564edbf0bed0
  jobId=4c0555b3-e1b1-44cf-af08-9e1b22bb2ae4
```

DataForSEO 预算事实：

```text
absoluteBudgetMicros=1000000
spentMicros=950976
reservedMicros=0
remainingMicros=49024
DATAFORSEO_MAX_PAID_CALLS=250
```

Worker 新运行实例的 `nextRecommendationInventoryScanAt` 初值为 `0`，后台服务
启动后立即执行 `runRelay()`，随后每 `500 ms` 运行 relay，并每 `15 s` 扫描一次
Recommendation Inventory。在 DataForSEO 保持启用时，该路径会：

1. 调用 `ensureCommercialRecommendationRefill(...)`；
2. 消费 Recommendation Refill outbox；
3. 消费 Project Analysis outbox；
4. 在到期时调度 Backlink Profile Sync。

现有旧 Worker 的 `20260811-100211-worker.stdout.log` 证明该启动路径不是纯只读：
它在 `2026-08-11 10:02:20 +08:00` 和
`2026-08-11 10:02:21 +08:00` 为两个 Website Project 创建了两个
Recommendation Refill Job，并发布了对应 outbox。

因此，在不关闭或降低 DataForSEO、又不修改 Canonical 业务状态的约束下，无法证明
重启不会消费现有 pending outbox、启动旧 Job 对应 Workflow，或触发新的
Recommendation Refill / Provider 调用。按照任务中的强制停止条件，本轮在重启前
停止。

### 配置与基础设施

未重启，现有配置保持不变：

```text
DataForSEO enabled=true
absoluteBudgetMicros=1000000
DATAFORSEO_MAX_PAID_CALLS=250
Gmail Send enabled=true
Gmail Sync enabled=true
DataForSEO 与 Gmail 控制仍相互独立
```

基础设施只读检查：

```text
PostgreSQL container health=healthy
PostgreSQL server version=18.4
Temporal health=healthy
Temporal namespace=growthos-backlinks-canary
Temporal namespaceReady=true
```

### 重启与 Status 结论

由于安全门阻塞，API、Worker、FastAPI 和前端均未重启，最小 smoke 未进入。

```text
Status exitCode=1
status=not_ready
build.matches=false

expected Build ID=
  local-product-2337ef16419c97c3e86628d1
configured API Build ID=
  backlinks-live001-2026.07.31.1
configured Worker Build ID=
  backlinks-live001-2026.07.31.1
running API Build ID=
  <empty>
running Worker Build ID=
  backlinks-live001-2026.07.31.1
```

`LOCAL-PRODUCT-034` 继续保持 `TESTED`；没有声明
`REAL_PROVIDER_VERIFIED`。

## LOCAL-PRODUCT-035 前置判断

`LOCAL-PRODUCT-035` 前置 **不满足**：

- `LOCAL-PRODUCT-034 = TESTED` 已满足；
- API/Worker Build ID 非空且与
  `local-product-2337ef16419c97c3e86628d1` 一致未满足；
- `status=ready` 与 `build.matches=true` 未满足。

`LOCAL-PRODUCT-035` 未启动。本轮没有 commit、push、创建或切换分支。
