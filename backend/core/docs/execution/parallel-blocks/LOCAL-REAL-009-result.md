# LOCAL-REAL-009 本地真实产品最终 Gate

- 执行日期：`2026-08-05`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-REAL-009`
- 状态：`PASS_WITH_EXTERNAL_ACTION`
- 当前 Website Project：`elephtv`
- 最终运行 ID：`20260805-103240`
- 唯一草稿审核入口：`http://localhost:5173/projects/elephtv/backlinks/drafts/8fce0822-4ef9-4010-b6a5-6f57308698dc`

## 1. 结论

当前 ElephTV Website Project 已能通过一个本地入口运行完整 Backlinks 产品。PostgreSQL、
Temporal、Core API、Backlinks Worker、FastAPI Gateway、Frontend 和共享 Browser Worker
均已启动并通过健康检查；真实 Recommendation、联系人发现、Opportunity、AI 草稿、Gmail
连接/同步状态、Placement 验证和周期监控由同一项目事实驱动。

本轮没有代替用户批准或发送邮件。当前草稿为真实 `MODEL` 草稿并处于“待审批”；Gmail 已连接，
发送与同步能力已开启，但 SendIntent、发送记录和 Gmail History cursor 仍为 `0`。剩余动作仅是
用户审核并点击批准/发送，以及真实收件人之后的外部回复。

## 2. A. 统一本地启动

仓库根目录已提供可直接执行的统一命令：

```powershell
.\Start-GrowthOS-LocalProduct.ps1 `
  -EnableAi `
  -EnableGmail `
  -EnableBrowser `
  -AiMaxCalls 25 `
  -GmailRolling24HourSendLimit 20 `
  -GmailMinimumIntervalSeconds 120 `
  -GmailPollingIntervalSeconds 60

.\Status-GrowthOS-LocalProduct.ps1
.\Restart-GrowthOS-LocalProduct.ps1 -SkipBuild
.\Stop-GrowthOS-LocalProduct.ps1
```

本轮完成的启动治理：

- `-EnableGmail` 同时启用 Gmail Send 和 Sync，也保留两个独立开关。
- Restart 默认复用上一轮 Provider 开关、调用上限和 Gmail 限额，允许显式覆盖。
- 显式启用 AI、Gmail 或 Browser 时，启动脚本幂等打开当前 Project 的对应数据库 Kill Switch。
- DataForSEO、AI 调用数和费用均有可配置上限，不再固定为单次 canary 额度。
- Browser 继续使用仓库现有共享 Browser Worker/Playwright Adapter，没有第二套 Worker 或 Queue。
- Status 输出 URL、监听端口、health/readiness、Provider 状态、预算余量、持久化事实数量和安全错误分类。
- Stop 保留 PostgreSQL/Temporal named volumes、业务数据和外部 Secret Store。
- 完整操作说明位于 `ops/local-product/LOCAL-PRODUCT-runbook.md`。

当前健康状态：

| 组件 | 地址 | 结果 |
| --- | --- | --- |
| Frontend | `http://localhost:5173` | `200` |
| FastAPI Gateway | `http://localhost:7200` | `200` |
| private Core | `http://127.0.0.1:7301` | `200` |
| Browser Worker | `http://127.0.0.1:7401` | `200` |
| PostgreSQL 18 | `127.0.0.1:55432` | healthy |
| Temporal | `127.0.0.1:57233` | healthy |
| Temporal metrics | `127.0.0.1:59090` | listening |

当前运行最近错误分类为空。Gmail callback 按真实 Project key 生成：

`http://localhost:7200/api/v1/projects/elephtv/backlinks/gmail-connections/callback`

## 3. B. 真实业务闭环

### 3.1 当前持久化事实

| 业务事实 | 数量/状态 |
| --- | --- |
| Project / Context Snapshot | `1 / 1` |
| Recommendation / Inventory | `20 / 20` |
| Contact Enrichment Job / Page | `18 / 324` |
| Contact Candidate / Evidence | `48 / 145` |
| Confirmed Contact | `1` |
| Opportunity | `4`，均已加入 |
| Gmail Connection | `1`，connected |
| Draft / DraftVersion | `1 / 2`；当前后端版本 `v3`，来源 `MODEL` |
| SendIntent / SendAttempt | `0 / 0`，等待人工批准和发送 |
| Gmail cursor / Message | `0 / 0`，同步状态为等待真实发送记录 |
| Placement Candidate / Placement | `2 / 1` |
| Validation Run | `1` |
| Monitoring Policy / Run / Observation | `1 / 3 / 3` |

### 3.2 API 与 UI 同源验证

- Recommendations API 返回 `20` 条；其中 `4` 条已进入 Opportunity，UI 推荐池显示剩余
  `16` 条，并显示公开联系人、证据、抓取页数和失败分类。
- Opportunities API 和 UI 均显示 `4` 条已加入机会。
- Draft API 返回真实草稿，状态 `draft`、来源 `MODEL`、当前版本 `v3`、要求用户确认。
- 草稿 UI 显示“待审批”和“人工批准”，没有自动批准或自动发送。
- Gmail 状态为 connected，Send/Sync 可用；邮件中心显示“等待真实发送记录”、轮询间隔
  `60` 秒、可匹配发送 `0` 条。
- Links UI 区分 Candidate 与 Confirmed，Candidate 不计成功 KPI。
- Confirmed Placement 为 `active`，最新 Observation 为 `present · static`，freshness 为
  `fresh`，监控任务和状态事件可见。
- Tasks 当前为 `0`；没有用邮件或 Opportunity 状态伪造 Task。

DataForSEO 在最终运行中保持关闭，已有 Recommendation、联系人、Opportunity、Draft、Gmail
状态、Placement 和监控仍可由 API/UI 正常读取，证明已有业务链不依赖每次启动都产生付费调用。

## 4. C. 恢复与隔离验证

本轮连续执行：

1. 完整 Stop，确认应用进程和 PostgreSQL/Temporal 容器停止，named volumes 未删除。
2. 使用 AI、Gmail、Browser 和配置上限重新 Start。
3. 再执行一次 `Restart-GrowthOS-LocalProduct.ps1 -SkipBuild`。

最终运行 ID 从 `20260805-100109` 更新为 `20260805-102823`，再更新为
`20260805-103240`。重启前后的 Project、库存、Contact、Opportunity、Draft、Gmail Connection、
Placement、Observation、MonitoringPolicy、预算和 Ledger 数量一致。

Send、Gmail cursor 和 Mail Message 在重启前后均为 `0`，原因是用户尚未批准/发送，不是恢复丢失。

项目隔离实测：

| Project key | Recommendations 请求 |
| --- | --- |
| `elephtv` | `200` |
| `live001-canary` | `403` |
| `missing-local-real-009` | `403` |

Backlinks production API/UI 源码扫描未发现 mock、fixture、`.example.invalid` 或 canary 作为当前
产品事实源，也未发现跨项目数据或 generated contract 字段错位。

## 5. 综合 Gate

### Core

`npm run verify:backlinks` 全部通过：

- typecheck、lint、dependency allowlist 和 license scan：passed
- source manifest：`28` 项
- licenses：`693` 项
- OpenAPI：`56` paths
- Backlinks migrations：`33` 个，head `0040`
- unit：`85` files，`481` tests passed
- API：`30` files，`101` tests passed
- contract：`26` files，`169` tests passed
- integration：`49` files passed、`4` skipped；`183` tests passed、`13` skipped
- security：`9` files，`105` tests passed
- resilience：`3` files，`8` tests passed
- 本地进程脚本定向测试：`12/12` passed

### Gateway、Frontend、Browser Worker 和 Crawler

- FastAPI Ruff：passed
- FastAPI pytest：`66 passed, 1 skipped`
- Frontend typecheck、lint、build：passed
- Frontend source tests：`45/45` passed
- Frontend Playwright：desktop `2/2`、mobile `1/1`、keyboard/axe `1/1`
- Browser Worker typecheck、build：passed；tests `1/1`
- Go Crawler：使用 `golang:1.25.4` Docker 镜像执行 `go test ./...`，全部 passed

### 数据库与安全

- PostgreSQL：`18.4`，非 recovery
- Alembic head：`20260724_0007`
- Backlinks head：`0040`
- Backlinks tables：`75`
- RLS enabled：`75/75`
- FORCE RLS：`75/75`
- policies：`92`
- 当前运行日志：扫描 `10` 个文件，private key、OAuth token、Google client ID、GitHub token
  和 API key 特征命中 `0`
- `git diff --check`：无 whitespace error，仅现有 Windows 行尾提示

## 6. 真实浏览器验证

使用 Playwright CLI 逐页读取真实运行中的：

- 推荐池
- Opportunities
- Gmail 邮件中心
- AI 草稿审核页
- Links Candidate/Confirmed 列表和 Placement 详情
- Outreach 治理设置

最终页面 console error 为 `0`。推荐池首次打开时出现过一个外部目标网站缺少 `favicon.ico` 的
`404`，GrowthOS API、页面和后续导航均正常，不属于产品运行错误。

草稿审核页截图：

`frontend/output/playwright/local-real-009-draft-review.png`

## 7. Provider 与预算

- DataForSEO：disabled；最大付费调用数 `25`
- AI：enabled；最大调用数 `25`；绝对预算 `USD 0.05`
- Gmail Send/Sync：enabled；`20` 封/24 小时；最小间隔 `120` 秒；轮询 `60` 秒
- Browser：enabled；共享 Worker，最大页面数和重试次数受限
- DataForSEO budget：limit `100000` micros，spent `55200`，reserved `0`，remaining `44800`
- Ledger：`2` 个 settled entries，actual `55200` micros

数据库治理视图中 AI、Browser、Gmail Send/Sync 和 DataForSEO 的项目 Kill Switch 均为开放。
DataForSEO 当前是否执行付费请求仍由显式 runtime Enable 开关决定。

## 8. 最少外部动作

1. 打开唯一草稿审核入口，核对真实收件人、主题和正文。
2. 由用户点击“人工批准”并执行 Gmail 发送。
3. 等待真实收件人回复；同步器将基于已接受发送记录建立 cursor 并轮询回复。

系统不得代替用户批准、自动发送或伪造回复。

## 9. 最终状态

`PASS_WITH_EXTERNAL_ACTION`

代码、数据库、契约、统一运行脚本、真实本地栈、Recommendation、联系人、Opportunity、AI 草稿、
Gmail 连接/同步、Placement 验证和监控均已完成并通过最终 Gate。仅等待用户控制的批准/发送和
真实收件人回复。

未执行 Git commit/push，未撤销用户改动，未发布公网，未使用 mock/fixture 伪装真实产品。
