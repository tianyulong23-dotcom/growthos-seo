# LOCAL-PRODUCT-025 组织级 Gmail 选择、持久启用与多项目 Sync 结果

- 执行日期：`2026-08-07`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-025`
- 最终状态：`PASS`
- 首次显式 Gmail Restart：`20260807-172401`
- 正常保留状态 Restart：`20260807-172624`
- Stop boundary：未执行 `LOCAL-PRODUCT-026..027`

## 1. 结论

`LOCAL-PRODUCT-025` 已完成：

1. 复验并继续使用 `LOCAL-PRODUCT-017` 的组织级 Gmail Connection、
   Workspace Binding、WebsiteProjectMailboxBinding、OAuth Attempt Store、
   加密 Token Secret Reference、Gmail Adapter 和 Temporal Sync Workflow。
2. 正常本地 Start/Restart 会在加密 Google OAuth Client Secret Reference
   可用时保留上一次 Gmail Send/Sync 启用状态，不再要求每次手工传入
   `-EnableGmail`。
3. CI、`NODE_ENV=test`、显式关闭或缺少合法 Secret Envelope 时仍 Fail
   Closed。
4. 启动 Sync 不再只读取当前浏览器项目，而是枚举 Organization/Workspace
   下所有有效项目 Mailbox Binding。
5. AWOL 与 ElephTV 的两个项目 Binding 选择同一个组织 Connection，只保留
   一份活动 Token Reference，并复用一个稳定的 Connection 级 Temporal
   Workflow。
6. 项目切换后，页面按项目 Query Key 重新读取各自 Binding；真实浏览器中
   从 ElephTV 切到 AWOL 后显示正确项目和账号，没有沿用前一项目缓存。
7. 选择已有账号继续走 `/select`，不创建 OAuth Attempt；只有新增账号或
   `REAUTH_REQUIRED` 才进入 OAuth。
8. Gmail 账号选择器已补齐当前项目账号及 `Send 可用/暂停`、
   `Sync 可用/暂停` 可见状态。
9. 两个项目的 SendIntent、SendAttempt、Thread、Message 均保持独立且为
   `0`；本轮没有真实 Gmail 发送，也没有拉取或复制邮件。
10. 保留历史账本、预算治理、缓存、幂等和 Kill Switch；没有新增第二套
    Provider、Queue、Crawler、Gmail Token Store 或业务数据模型。

本轮未 commit、未 push，未清理、撤销或覆盖工作树中的无关改动。

## 2. 017 复验与实现边界

`LOCAL-PRODUCT-017-result.md` 已证明并由本轮数据库再次确认：

| 既有能力 | 025 处理 |
| --- | --- |
| Organization Gmail Connection | 复用，不重建 |
| 稳定 OAuth Callback | 复用，不修改 |
| Workspace Binding | 复用 |
| Website Project Mailbox Binding | 复用 |
| Token Secret Reference | 复用，一份活动引用 |
| OAuth Attempt / PKCE Store | 复用 |
| Gmail Provider Adapter | 复用 |
| Temporal Gmail Polling Workflow | 复用 |
| 项目级 Send/Thread/Message 所有权 | 保留 |

现有 Callback 仍为：

```text
http://localhost:7200/api/v1/backlinks/gmail-connections/callback
```

本轮没有改动数据库结构、OAuth Callback、Provider Adapter 或 Token
持久化模型。

## 3. 最小实现范围

本轮在已有脏工作树中的共享文件上，只追加或调整以下 025 相关逻辑：

```text
ops/local-product/Start-GrowthOS-LocalProduct.ps1
ops/local-product/LOCAL-PRODUCT-runbook.md
backend/core/test/unit/local-product-process-scripts.test.ts
frontend/src/features/outreach/gmail/gmail-account-selector.tsx
frontend/src/features/outreach/gmail/gmail-source.test.mjs
backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-025-result.md
```

关键实现：

- `Resolve-GmailCapabilityEnabled` 区分显式参数、正常状态恢复、CI/test 和
  缺失 Secret。
- `Test-GoogleOauthSecretReferenceAvailable` 只接受合法本地 Secret
  Reference、Master Key 和匹配的 `GOOGLE_OAUTH_CLIENT_SECRET` Envelope。
- 删除启动时自动选择、改写 Workspace Binding 的 SQL；项目选择继续由
  用户命令和 Core 权威路径负责。
- 启动 Sync 查询所有活动项目、Selected Mailbox Binding、Active Workspace
  Binding 和 Connection。
- 每个项目均调用现有 `/sync` 命令；单项目启动失败记录
  `PROJECT_GMAIL_SYNC_START_FAILED` 后继续其他项目。
- Runtime State 记录项目到 Workflow 的映射及去重后的 Workflow ID。
- UI 继续使用现有真实账号选择器，只补齐 Send/Sync 能力状态。

## 4. Restart 与运行配置

首次显式启用：

```powershell
.\ops\local-product\Restart-GrowthOS-LocalProduct.ps1 `
  -EnableGmail `
  -SkipBuild
```

结果：

```text
runId=20260807-172401
GMAIL_SEND_ENABLED=true
GMAIL_SYNC_ENABLED=true
```

随后不带 Gmail 开关的正常 Restart：

```powershell
.\ops\local-product\Restart-GrowthOS-LocalProduct.ps1 -SkipBuild
```

最终结果：

```text
runId=20260807-172624
GMAIL_SEND_ENABLED=true
GMAIL_SYNC_ENABLED=true
DATAFORSEO_ENABLED=true
```

API 与 Worker 的持久化环境一致：

```text
GMAIL_SEND_ENABLED=true
GMAIL_SYNC_ENABLED=true
DATAFORSEO_ENABLED=true
GOOGLE_OAUTH_CLIENT_SECRET_REF=secret://***/v1
```

正常 Restart 后不需要再次手工输入 Gmail 开关。脚本级测试同时确认：

- `CI=true` 时 Gmail 为关闭；
- `NODE_ENV=test` 时 Gmail 为关闭；
- 显式 `-EnableGmail:$false` 或单能力关闭优先；
- Secret Reference、Master Key 或匹配 Envelope 缺失时关闭。

## 5. Gmail Provider 脱敏证据

活动 Connection：

| 字段 | 结果 |
| --- | --- |
| Connection | `ce7b81a9...c737` |
| Email | `t***@gmail.com` |
| connectionStatus | `CONNECTED` |
| sendAvailability | `AVAILABLE` |
| mailSyncCapability | `true` |
| recentErrorCategory | `null` |
| Token Secret Kind | `GMAIL_TOKEN_SET` |
| Token Secret Version | `v9` |
| Token Reference Status | `ACTIVE` |

本地加密 Envelope 元数据：

| Secret Kind | Version | Algorithm | Ciphertext |
| --- | --- | --- | --- |
| `GOOGLE_OAUTH_CLIENT_SECRET` | `v1` | `aes-256-gcm` | present |
| `GMAIL_TOKEN_SET` | `v9` | `aes-256-gcm` | present |

没有把 Client Secret、Access Token、Refresh Token、PKCE 或原始邮箱写入本
结果文件。

Token 健康检查日志：

```text
outcome=REFRESHED
connectionStatus=CONNECTED
recentErrorCategory=null
```

单个 Connection 的 `invalid_grant` 仍通过已有仓储路径将该 Connection 标记
为 `REAUTH_REQUIRED`，暂停该 Connection 的 Send/Sync，不修改全局 Gmail
开关，也不关闭其他健康 Connection。

## 6. Organization Connection 与项目 Binding

数据库终态：

| 检查 | 结果 |
| --- | ---: |
| Gmail Connection 历史总数 | 2 |
| 当前活动 Connection | 1 |
| 当前活动 Token Reference | 1 |
| 活动 Workspace Binding | 1 |
| Selected Project Binding | 2 |
| Selected 项目数 | 2 |
| Selected Connection 数 | 1 |
| OAuth Attempt 历史总数 | 17 |
| 当前有效未消费 OAuth Attempt | 0 |

项目选择：

| 项目 | Connection | Selected | Binding Version | Updated At UTC |
| --- | --- | --- | ---: | --- |
| `awolvision-com-4ec81dca` | `ce7b81a9...c737` | true | 1 | `2026-08-06 12:31:26.745933` |
| `elephtv` | `ce7b81a9...c737` | true | 1 | `2026-08-04 14:38:33.918062` |

两次 Restart 后 Binding 的 version 和 updated_at 未变化，证明启动过程没有
擅自切换默认 Gmail 或重写历史选择。

本轮真实页面切换和读取没有创建新 OAuth Attempt，也没有调用新增 Connection
的 `/connect` 路径。

## 7. 多项目 Sync 与稳定 Workflow

最终 Runtime State：

```text
gmailSyncWorkflows=2
gmailSyncWorkflowIds=1
gmailSyncStartFailures=0
```

项目映射：

| 项目 | Connection | Workflow |
| --- | --- | --- |
| AWOL | `ce7b81a9...c737` | 同一稳定 Connection Workflow |
| ElephTV | `ce7b81a9...c737` | 同一稳定 Connection Workflow |

脱敏 Workflow ID：

```text
backlinks:11111111...:cec65d3f...:gmail-connection:
gmail-polling-sync:v1:ce7b81a9...c737
```

Temporal：

```text
Type=backlinksGmailPollingSyncV1Workflow
Namespace=growthos-backlinks-canary
TaskQueue=growthos.backlinks.v1
CancelRequested=false
PendingActivities=0
```

Core 启动日志分别记录：

```text
local-product-20260807-172624-gmail-sync-awolvision-com-4ec81dca -> 202
local-product-20260807-172624-gmail-sync-elephtv -> 202
```

Provider 拉取按 Connection 共享；Thread/Message 投影继续按
`website_project_id` 和已有归属隔离，不会把同一邮件复制给无关项目。

## 8. 定向 API 与零发送

带 `x-request-id` 的真实 API 读取结果：

| 项目 | Account | Status | Send | Sync | Sync State | Accepted Send | Cursor |
| --- | --- | --- | --- | --- | --- | ---: | --- |
| AWOL | `t***@gmail.com` | CONNECTED | AVAILABLE | true | WAITING_FOR_ACCEPTED_SEND | 0 | absent |
| ElephTV | `t***@gmail.com` | CONNECTED | AVAILABLE | true | WAITING_FOR_ACCEPTED_SEND | 0 | absent |

两者返回同一稳定 Workflow ID，Polling Interval 为 `60` 秒，
`killSwitchOpen=true`。

项目业务数据：

| 项目 | SendIntent | SendAttempt | Thread | Message |
| --- | ---: | ---: | ---: | ---: |
| AWOL | 0 | 0 | 0 | 0 |
| ElephTV | 0 | 0 | 0 | 0 |

当前 Connection 级 Provider Sync Cursor 数为 `0`。由于没有 Accepted Send，
Workflow 保持等待状态，没有真实 Gmail 拉取或自动发送。

## 9. UI 与项目切换

真实浏览器在 ElephTV 邮件中心显示：

- 组织已授权账号数 `1`；
- 当前项目发件账号；
- `CONNECTED`；
- `Send 可用`；
- `Sync 可用`；
- “选择已有账号不会再次打开 Google 授权”；
- 重新授权入口；
- Sync 状态 `WAITING_FOR_ACCEPTED_SEND`；
- Kill Switch 为开启；
- Accepted Send 为 `0`。

通过实际项目选择器切到 AWOL 后：

```text
/projects/awolvision-com-4ec81dca/backlinks/email
```

页面显示 AWOL 项目上下文和该项目从服务端返回的 Selected Binding。连续两次
刷新后仍正确，没有串用 ElephTV 的前端缓存。浏览器请求只有项目、Gmail
status、mail messages 和 sync-status 读取，没有 DataForSEO 请求，也没有
Gmail `/connect`、发送或选择写操作。

最终浏览器 Console：

```text
Errors=0
Warnings=0
```

导航和刷新造成的旧请求 `ERR_ABORTED` 均由后续同路由 `200` 替代，不是
Provider、数据库或业务失败。

## 10. DataForSEO 预算与推荐结果

### 10.1 官方账户与内部预算分离

| 项目 | 事实 |
| --- | --- |
| DataForSEO 官方账户余额 | 本轮未查询，不记录或推测数值 |
| GrowthOS 当前内部周期上限 | `1,000,000 micros` |
| 025 初始已消费 | `478,980 micros` |
| 025 最终已消费 | `530,616 micros` |
| 当前预留 | `0 micros` |
| 当前内部剩余 | `469,384 micros` |
| 当前 Budget Version | `45` |

DataForSEO 官方余额与 GrowthOS 内部预算是两个独立事实。本轮没有重置预算
周期，也没有删除、清零或改写历史 Ledger。

### 10.2 本轮账本变化归因

025 Gmail Restart、项目切换和页面刷新本身没有产生 DataForSEO 请求。

在本轮最终核对前，既有 Backlink Profile Scheduler 于
`2026-08-07 17:44:21 +08:00` 执行了一次按小时 continuation：

```text
Profile Sync Job: a34cfec1...d1e8
trigger_source: continuation
idempotency_key:
  backlink-profile:schedule:2:2026-08-07T09:44:11.000Z
```

其两条真实受治理请求：

| 脱敏 Request | Endpoint | 状态 | 实际成本 |
| --- | --- | --- | ---: |
| `d74de439...758a` | `/v3/backlinks/summary/live` | succeeded/settled | 24,036 |
| `769e62ba...e2e9` | `/v3/backlinks/backlinks/live` | succeeded/settled | 27,600 |

合计 `51,636 micros`，因此当前周期：

```text
478,980 -> 530,616 micros
```

这是已有 Profile Scheduler 的定时 continuation，不是页面刷新触发，也不是
Gmail Restart 产生的重复请求。对应下一次时间仍由现有 Profile Policy 和
Kill Switch 治理。

当前周期 Ledger：

```text
settled=20
released=2
reserved=0
actual=530616 micros
```

全部历史周期累计：

```text
budget_periods=3
spent=641016 micros
reserved=0
ledger_entries=26
settled=24
released=2
```

### 10.3 推荐发布门禁

推荐 Inventory 总数为 `51`，当前发布 `8`，且 `8/8` 都满足：

```text
publication_status=PUBLISHED
verified_public_email_count>0
default_contact_source_url IS NOT NULL
default_contact_email_reference IS NOT NULL
```

发布结果：

| 项目 | 网站 | 公开邮箱数 | 公开证据页 |
| --- | --- | ---: | --- |
| AWOL | `bizcommunity.com` | 1 | `https://www.bizcommunity.com/SubmitNews.aspx` |
| AWOL | `homecinemasdubai.com` | 1 | `https://homecinemasdubai.com/home-cinemas-products-dubai/home-cinemas-speakers-and-subwoofers/` |
| AWOL | `mountingmasters.co.za` | 1 | `https://mountingmasters.co.za/dstv-greenstone-hill/` |
| AWOL | `newsdirectory3.com` | 1 | `https://www.newsdirectory3.com/category/entertainment/` |
| AWOL | `reach.dog` | 1 | `https://app.reach.dog/welcome` |
| AWOL | `stuff.co.za` | 1 | `https://stuff.co.za/category/news/app-news/page/2/` |
| AWOL | `themiddle.co` | 1 | `https://themiddle.co/contact/` |
| AWOL | `thesouthafrican.com` | 1 | `https://www.thesouthafrican.com/contact-us/` |

ElephTV 当前发布推荐为 `0`。025 没有修改 Recommendation 数据，也没有发布
缺少合规公开邮箱的网站。

## 11. 验证命令

PowerShell 解析：

```powershell
[void][scriptblock]::Create(
  (Get-Content .\ops\local-product\Start-GrowthOS-LocalProduct.ps1 -Raw)
)
[void][scriptblock]::Create(
  (Get-Content .\ops\local-product\Restart-GrowthOS-LocalProduct.ps1 -Raw)
)
```

Backend Unit/Contract：

```powershell
cd backend\core
npm exec vitest run -- `
  test/unit/local-product-process-scripts.test.ts `
  test/unit/local-product-gmail-sync-runtime.test.ts `
  test/unit/gmail-send-policy-gate.test.ts `
  test/unit/gmail-send-activity.test.ts `
  test/unit/gmail-send-intent-repository.test.ts `
  test/contract/gmail-connection-route.test.ts `
  test/contract/google-auth-port.test.ts `
  test/unit/gmail-connection-disconnect.test.ts
```

结果：`8 files, 59 tests PASS`。

Backend Integration：

```powershell
npm exec vitest run -- `
  test/backlinks/integration/gmail-auth-repositories.test.ts `
  test/backlinks/integration/mail-initial-sync-repository.test.ts `
  test/backlinks/integration/mail-incremental-sync-repository.test.ts
```

结果：`3 files, 13 tests PASS`。

Backend 静态验证：

```powershell
npm run typecheck
npm run lint
npm run build
```

结果：全部 PASS。

Frontend：

```powershell
cd frontend
node --test src/features/outreach/gmail/gmail-source.test.mjs
npm run typecheck
npm run lint
npm run build
```

结果：

```text
gmail-source.test.mjs: 5/5 PASS
typecheck: PASS
lint: PASS
build: PASS
```

Build 只有既有的大于 `500 kB` chunk 警告。

最终运行状态：

```powershell
.\ops\local-product\Status-GrowthOS-LocalProduct.ps1 -Json
```

定向 Gmail API：

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:7200/api/v1/projects/<project>/backlinks/gmail-connections/status" `
  -Headers @{ "x-request-id" = "local-product-025-status-<project>" }

Invoke-RestMethod `
  -Uri "http://localhost:7200/api/v1/projects/<project>/backlinks/gmail-connections/<connection>/sync-status" `
  -Headers @{ "x-request-id" = "local-product-025-sync-<project>" }
```

Temporal：

```powershell
docker exec growthos-live001-temporal temporal workflow describe `
  --namespace growthos-backlinks-canary `
  --workflow-id "<stable-gmail-workflow-id>"
```

工作树检查：

```powershell
git diff --check -- `
  ops/local-product/Start-GrowthOS-LocalProduct.ps1 `
  ops/local-product/LOCAL-PRODUCT-runbook.md `
  backend/core/test/unit/local-product-process-scripts.test.ts `
  frontend/src/features/outreach/gmail/gmail-account-selector.tsx `
  frontend/src/features/outreach/gmail/gmail-source.test.mjs `
  backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-025-result.md
```

## 12. 最终状态

```text
LOCAL-PRODUCT-025=PASS
Frontend=HTTP 200
FastAPI=HTTP 200
Private Core=HTTP 200
PostgreSQL=healthy
Temporal=healthy
Gmail Send=enabled
Gmail Sync=enabled
DataForSEO=enabled
Gmail real sends=0
Gmail real pulls=0
OAuth attempts added=0
Project sync mappings=2
Unique Gmail workflow IDs=1
Sync start failures=0
Published recommendations=8
Published recommendations with compliant public email=8
Commit=false
Push=false
LOCAL-PRODUCT-026 executed=false
```

`Status-GrowthOS-LocalProduct.ps1` 仍会汇总旧的浏览器中止请求和 Worker
可恢复错误类别；最终监听、HTTP、PostgreSQL、Temporal、Gmail Connection
健康检查和定向 API 均通过。这些历史日志项未导致 Gmail 或 Provider 全局
关闭。
