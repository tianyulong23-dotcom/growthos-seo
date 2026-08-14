# LOCAL-PRODUCT-026 Gmail 发送可用性、错误语义与回复同步收口结果

- 执行日期：`2026-08-07`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-026`
- 最终状态：`PASS_CODE_USER_SEND_READY`
- 最终本地运行 ID：`20260807-184546`
- Stop boundary：未执行 `LOCAL-PRODUCT-027`

## 1. 结论

`LOCAL-PRODUCT-026` 已完成：

1. 新增服务端 SendIntent Preflight，并在生成 SendIntent ID、Snapshot、额度
   Reservation 或任何 Gmail 调用之前执行。
2. Preflight 校验项目 Gmail Binding、Connection/Scope、Send Runtime、
   Worker/Temporal、联系人版本、草稿版本、发件身份、Suppress/Unsubscribe、
   频率、额度和 Kill Switch。
3. 明确失败返回稳定 Typed Error 和 `NOT_SENT`；不再把 Gmail Send 关闭或
   连接错误表达为“最终提交结果未知”。
4. 用户最终确认创建 SendIntent 时，服务端再次执行同一权威校验，不信任
   页面缓存的 Preflight 结果。
5. 页面发送区显示 Gmail、Connection、Send、Sync 和不可发送原因，并提供
   选择账号、重新授权、刷新检查和立即同步等修复动作。
6. 页面区分 `NOT_SENT`、`QUEUED`、`SUBMITTED/SENT` 和 `UNKNOWN`；只有
   `NOT_SENT` 允许修复后重试，`UNKNOWN` 禁止盲目重复发送。
7. Polling Sync 保持稳定 Workflow ID、60 秒周期、增量 Cursor 和既有
   Thread/Message 幂等归属；单次失败可显示最后成功、错误和下次重试。
8. FastAPI Gateway 已补齐 Send Preflight 代理路由，Core 和公开 OpenAPI
   仍是唯一业务权威。
9. 正常 Restart 后 Gmail Send、Gmail Sync 和 DataForSEO 均继续启用；
   页面刷新和 Preflight 没有产生重复付费调用或发送记录。
10. 本轮没有自动向真实联系人发邮件，因此唯一剩余人工动作是用户在页面
    Preflight 通过后点击最终发送确认。

本轮未创建第二套 Provider、Queue、Crawler、Token Store 或业务数据模型；
保留历史账本、预算治理、缓存、幂等、Attempt Ledger、Provider Message ID、
Unknown Reconciliation、人工最终确认和 Kill Switch。本轮未 commit、未
push，也未清理、撤销或覆盖工作树中的无关改动。

## 2. 稳定错误语义

服务端和页面已统一处理：

```text
GMAIL_CONNECTION_NOT_SELECTED
GMAIL_REAUTH_REQUIRED
GMAIL_SEND_DISABLED
GMAIL_SCOPE_INSUFFICIENT
GMAIL_WORKER_UNAVAILABLE
CONTACT_VERSION_STALE
DRAFT_VERSION_STALE
SEND_POLICY_REJECTED
```

明确 Preflight 失败的共同语义：

```text
deliveryState=NOT_SENT
SendIntent created=false
Gmail called=false
retry after repair=true
```

用户确认后的状态语义：

| 状态 | 页面语义 | 重试规则 |
| --- | --- | --- |
| `NOT_SENT` | 确定未发送 | 修复后可重新 Preflight |
| `QUEUED` | 已创建 SendIntent，尚未确认 Provider 接受 | 不重复创建 |
| `SUBMITTED/SENT` | Gmail 已明确接受或已完成 | 不重复发送 |
| `UNKNOWN` | Dispatch 后结果不确定 | 禁止盲目重发，进入对账 |

## 3. 主要实现范围

### 3.1 Core

```text
backend/core/src/modules/backlinks/domain/errors/backlink-error.ts
backend/core/src/modules/backlinks/api/problem-details.ts
backend/core/src/modules/backlinks/api/send-intent.schema.ts
backend/core/src/modules/backlinks/api/send-intent.route.ts
backend/core/src/modules/backlinks/application/commands/send-intent.command.ts
backend/core/src/modules/backlinks/application/services/send-intent.repository.ts
backend/core/src/modules/backlinks/runtime/local-product-gmail-runtime.ts
backend/core/src/modules/backlinks/runtime/local-product-gmail-sync-runtime.ts
backend/core/src/modules/backlinks/runtime/production-runtime.ts
backend/core/src/modules/backlinks/application/workflows/gmail-polling-sync-workflow.ts
backend/core/src/modules/backlinks/workflows/client.ts
backend/core/src/modules/backlinks/workflows/definitions/gmail-polling-sync.workflow.ts
```

Preflight 的 PostgreSQL 检查与 SendIntent 创建复用同一权威规则。创建命令在
写入前再次检查，避免页面检查通过后联系人、草稿、Binding 或策略发生变化。

Production Runtime 使用 Temporal Task Queue Poller 状态判断 Worker 可用性，
不是只检查进程 PID。

### 3.2 Gateway 与契约

```text
backend/api/app/api/routes/backlinks.py
backend/api/tests/test_backlinks_gateway.py
backend/api/tests/test_shared_contracts.py
backend/contracts/openapi/backlinks.v1.json
backend/contracts/openapi/platform.v1.json
```

新增公开代理：

```text
POST /api/v1/projects/{websiteProjectKey}/backlinks/drafts/{draftId}/send-preflight
```

最终契约：

```text
Backlinks OpenAPI paths=70
Generated Backlinks client operations=71
Platform aggregate paths=90
Platform aggregate operations=96
```

### 3.3 Frontend

```text
frontend/src/api/client.ts
frontend/src/features/outreach/drafts/api.ts
frontend/src/features/outreach/drafts/types.ts
frontend/src/features/outreach/drafts/draft-page.tsx
frontend/src/features/outreach/mail/mail-center.tsx
frontend/test/support/outreach-api-fixtures.ts
frontend/test/outreach-desktop.spec.ts
frontend/test/outreach-mobile.spec.ts
```

`ApiError` 保留 `application/problem+json` 根级 `code/detail/retryable`，页面可
按稳定错误码显示明确原因和修复动作。发送按钮只有在最新 Preflight 通过后
才进入用户最终确认；刷新页面不会创建 SendIntent。

## 4. 正常 Restart 与运行状态

执行：

```powershell
.\ops\local-product\Restart-GrowthOS-LocalProduct.ps1 -SkipBuild
.\ops\local-product\Status-GrowthOS-LocalProduct.ps1
```

最终状态：

```text
runId=20260807-184546
runtimeMode=LOCAL_PRODUCT
Frontend=HTTP 200
FastAPI=HTTP 200
Private Core=HTTP 200
PostgreSQL=healthy
Temporal=healthy
Worker=running
recentErrors=0
Gmail Send=true
Gmail Sync=true
DataForSEO=true
Alembic head=20260806_0009
Backlinks migration head=0052
```

正常 Restart 没有关闭 Gmail 或 DataForSEO，也没有改写两个项目已有的 Gmail
Binding。

## 5. 真实 Gmail Provider 脱敏证据

最终数据库和真实 Runtime 检查：

| 字段 | 结果 |
| --- | --- |
| Connection | `ce7b81a9...c737` |
| Email | `t***@gmail.com` |
| connectionStatus | `CONNECTED` |
| sendAvailability | `AVAILABLE` |
| Gmail Send Scope | `true` |
| mailSyncCapability | `true` |
| Token Secret Kind | `GMAIL_TOKEN_SET` |
| Token Secret Version | `v11` |
| Token Reference Status | `ACTIVE` |
| Selected projects | `2` |

AWOL 和 ElephTV 继续选择同一个组织级 Connection。结果文件没有记录原始
邮箱、Client Secret、Access Token、Refresh Token、PKCE 或 Secret
Reference 的外部存储标识。

## 6. 真实 Preflight 证据

### 6.1 健康账号

通过 FastAPI Gateway 对 AWOL 的真实已批准 Draft 执行：

```text
HTTP=200
allowed=true
deliveryState=NOT_SENT
checkedAt=2026-08-07T10:57:03.337Z
connection=ce7b81a9...c737
email=t***@gmail.com
connectionStatus=CONNECTED
sendAvailability=AVAILABLE
mailSyncCapability=true
```

`NOT_SENT` 表示检查通过但尚未取得用户最终确认，不表示已提交邮件。

### 6.2 未选择账号

使用不属于项目 Binding 的 Connection ID 执行同一 Preflight：

```text
HTTP=409
code=GMAIL_CONNECTION_NOT_SELECTED
detail=Select the Gmail account for this project before sending.
retryable=false
```

两次 Preflight 后，AWOL 和 ElephTV 的数据库终态均为：

| 项目 | SendIntent | SendAttempt | SendSnapshot | Cursor | Thread | Message |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AWOL | 0 | 0 | 0 | 0 | 0 | 0 |
| ElephTV | 0 | 0 | 0 | 0 | 0 | 0 |

DataForSEO Provider Request 数在这两次 Preflight 前后均为 `31`。因此页面
刷新式检查不会创建发送记录、调用 Gmail 或触发 DataForSEO 付费发现。

## 7. Gmail Polling Sync

立即同步命令：

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:7200/api/v1/projects/<project>/backlinks/gmail-connections/<connection>/sync" `
  -Headers @{ "x-request-id" = "local-product-026-sync" } `
  -ContentType "application/json" `
  -Body "{}"
```

真实结果：

```text
commandStatus=ACCEPTED
workflowId=backlinks:11111111...:cec65d3f...:
  gmail-connection:gmail-polling-sync:v1:ce7b81a9...
state=WAITING_FOR_ACCEPTED_SEND
pollingIntervalSeconds=60
killSwitchOpen=true
acceptedSendCount=0
lastSuccessfulSyncAt=null
lastError=null
nextRetryAt=null
cursor=null
```

数据库最新 `GMAIL_SYNC` Kill Switch 版本为 `blocked=false`。当前没有任何
已接受发送，因此 Workflow 正常等待，不会为完成 Coding 任务而拉取或伪造
邮件；后台 Workflow 仍持续存在，立即同步命令没有替代周期运行。

当发生真实发送和回复后，现有仓储继续按 Project、Opportunity 和原 Gmail
Connection 归属，使用增量 Cursor 以及 Provider Message/Thread 唯一约束
幂等写入。Sync 错误状态包含最后成功时间、错误和下次重试，页面不会因一次
失败无限加载。

## 8. DataForSEO 官方余额与 GrowthOS 内部预算

二者严格分开：

| 项目 | 结果 |
| --- | --- |
| DataForSEO 官方账户余额 | 本轮未调用官方余额端点，不记录、不推断数值 |
| GrowthOS 内部预算上限 | `1,000,000 micros` |
| 内部已花费 | `582,252 micros` |
| 内部预留 | `0` |
| 内部剩余 | `417,748 micros` |
| Budget version | `49` |

本轮运行窗口内的内部变化：

| 指标 | Preflight 前基线 | 最终 | 变化 |
| --- | ---: | ---: | ---: |
| DataForSEO Provider Requests | 29 | 31 | +2 |
| Internal spent micros | 530,616 | 582,252 | +51,636 |
| Current-budget ledger entries | 22 | 24 | +2 |
| Settled | 20 | 22 | +2 |
| Released | 2 | 2 | 0 |
| Reserved | 0 | 0 | 0 |

这两次真实 DataForSEO 请求发生在 `2026-08-07 18:44` 左右，来源是 023 已
存在的 Backlink Profile 小时级 Continuation，不是页面刷新、Send Preflight、
Gateway 修复、Gmail Restart 或发送动作。最新 Provider Request 时间为：

```text
2026-08-07T10:44:35.422231Z
```

预算没有超过上限，剩余 `417,748 micros`，因此本轮没有重置预算周期。历史
Budget 和 Usage Ledger 均保留；无 `reserved` 或 `unknown_charge` 悬挂项。
内部成本不能当作 DataForSEO 官方账户余额。

## 9. 推荐数据结果

当前两个目标项目的 Recommendation Inventory：

| 项目 | Inventory | Published | Published with compliant public email |
| --- | ---: | ---: | ---: |
| AWOL | 30 | 8 | 8 |
| ElephTV | 20 | 0 | 0 |
| 合计 | 50 | 8 | 8 |

已发布的 8 个网站全部满足：

```text
publication_status=PUBLISHED
verified_public_email_count>0
default_contact_source_url IS NOT NULL
default_contact_email_reference IS NOT NULL
```

| 网站 | 公开邮箱数 | 公开证据页 |
| --- | ---: | --- |
| `bizcommunity.com` | 1 | `https://www.bizcommunity.com/SubmitNews.aspx` |
| `homecinemasdubai.com` | 1 | `https://homecinemasdubai.com/home-cinemas-products-dubai/home-cinemas-speakers-and-subwoofers/` |
| `mountingmasters.co.za` | 1 | `https://mountingmasters.co.za/dstv-greenstone-hill/` |
| `newsdirectory3.com` | 1 | `https://www.newsdirectory3.com/category/entertainment/` |
| `reach.dog` | 1 | `https://app.reach.dog/welcome` |
| `stuff.co.za` | 1 | `https://stuff.co.za/category/news/app-news/page/2/` |
| `themiddle.co` | 1 | `https://themiddle.co/contact/` |
| `thesouthafrican.com` | 1 | `https://www.thesouthafrican.com/contact-us/` |

本轮没有发布缺少合规公开邮箱的网站，也没有把 Recommendation 直接变成
Opportunity。

## 10. 验证命令与结果

Core：

```powershell
cd backend/core
npm run typecheck
npm run lint
npm run build
npx vitest run `
  test/unit/gmail-send-intent-command.test.ts `
  test/unit/gmail-send-intent-repository.test.ts `
  test/unit/local-product-gmail-sync-runtime.test.ts `
  test/unit/production-runtime.test.ts `
  test/backlinks/api/send-intent-route.test.ts `
  test/backlinks/api/private-server.test.ts
npx vitest run `
  test/backlinks/integration/send-quota-repository.test.ts `
  test/backlinks/integration/gmail-send-reply-loop-migration.test.ts `
  test/backlinks/integration/mail-incremental-sync-repository.test.ts `
  --maxWorkers=1
npm run openapi:backlinks:check
```

结果：

```text
typecheck=PASS
lint=PASS
build=PASS
targeted unit/api=47 passed
targeted integration=22 passed
Backlinks OpenAPI=70 paths PASS
```

FastAPI Gateway 与共享契约：

```powershell
& "$env:LOCALAPPDATA\GrowthOS\live001\python\Scripts\python.exe" `
  -m pytest `
  backend/api/tests/test_backlinks_gateway.py `
  backend/api/tests/test_shared_contracts.py `
  -q -ra
```

结果：

```text
24 passed
```

Frontend：

```powershell
cd frontend
npm run typecheck
npm run lint
npm run build
npm run check:backlinks-client
node --test `
  src/features/outreach/drafts/draft-server-source.test.mjs `
  src/features/outreach/mail/mail-center-source.test.mjs `
  src/features/outreach/gmail/gmail-source.test.mjs
npx playwright test test/outreach-desktop.spec.ts
npx playwright test test/outreach-mobile.spec.ts
```

结果：

```text
typecheck=PASS
lint=PASS
build=PASS
generated client=71 operations PASS
targeted source tests=13 passed
desktop Playwright=5 passed
mobile Playwright=1 passed
```

运行态：

```powershell
.\ops\local-product\Status-GrowthOS-LocalProduct.ps1

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:7200/api/v1/projects/<project>/backlinks/drafts/<draft>/send-preflight" `
  -Headers @{ "x-request-id" = "local-product-026-preflight" } `
  -ContentType "application/json" `
  -Body "<approved draft/contact/selected Gmail payload>"
```

## 11. 唯一剩余人工动作

用户打开已批准 Draft，在页面确认：

```text
Gmail=CONNECTED
Send=AVAILABLE
Sync=AVAILABLE
Preflight=通过
```

然后由用户本人点击最终发送确认。只有用户完成该动作后，才可进一步核对一个
SendIntent、一个有效 Provider 提交、真实最终状态和刷新不重发。本轮没有
代替用户执行真实发送。

## 12. 最终状态

```text
LOCAL-PRODUCT-026=PASS_CODE_USER_SEND_READY
Frontend=HTTP 200
FastAPI=HTTP 200
Private Core=HTTP 200
PostgreSQL=healthy
Temporal=healthy
Worker=running
Gmail Provider=CONNECTED
Gmail Send=enabled
Gmail Sync=enabled
DataForSEO=enabled
Preflight healthy account=PASS
Preflight typed failure=PASS
Gmail real sends=0
SendIntent=0
SendAttempt=0
MailThread=0
MailMessage=0
Published recommendations=8
Published recommendations with compliant public email=8
Official DataForSEO balance queried=false
Internal DataForSEO remaining micros=417748
Budget reset=false
Commit=false
Push=false
LOCAL-PRODUCT-027 executed=false
```
