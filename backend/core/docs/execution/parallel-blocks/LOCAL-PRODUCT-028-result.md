# LOCAL-PRODUCT-028 本地真实外链产品全链路 Gate 结果

- 执行日期：`2026-08-07`（星期五）
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-028`
- 最终状态：`PASS_LOCAL_REAL_READY`
- Stop boundary：未执行 `QUALITY-BACKLOG-001` 或任何后续 Coding Block

## 1. 结论

`LOCAL-PRODUCT-023..027` 的代码与真实持久事实已重新验证，不以历史 Result
声明代替运行检查。当前本地产品可以在正常 Restart 后继续使用 Frontend、
FastAPI Gateway、私有 Backlinks Core、现有 Worker、PostgreSQL 18、Temporal、
DataForSEO、Gmail Send 和 Gmail Sync。

本轮没有进行新的真实邮件最终发送，也没有等待新的收件人回复，因此按 028
人工验收边界返回 `PASS_LOCAL_REAL_READY`，不虚报
`PASS_LOCAL_REAL_E2E`，也不把人工确认边界误判为 `BLOCKED`。

没有创建第二套 Provider、Queue、Crawler、Worker、Scheduler 或业务数据模型。
Core 继续拥有业务状态，PostgreSQL 继续是事实源，Temporal 继续承担持久任务，
Recommendation 只有经用户确认才转为 Opportunity，Gmail 发送继续要求人工
最终确认。没有 commit、push、reset、clean 或覆盖无关工作树改动。

## 2. 028 修正

### 2.1 启动配置与可移植性

- Start 增加 `-PreflightOnly`，复用正式启动的配置解析路径，但不停止服务、
  不构建、不重写活动配置。
- 正常 Start/Restart 在加密 Secret Reference 仍可用时保留 DataForSEO 和
  Gmail Send/Sync 的已启用状态。
- CI/test 默认关闭真实 Provider；显式请求但 Secret 缺失时分别返回
  `LOCAL_PRODUCT_DATAFORSEO_CONFIG_REQUIRED` 或
  `LOCAL_PRODUCT_GMAIL_CONFIG_REQUIRED`，不伪装 Fake 成功。
- checked-in 示例只包含 Schema、安全默认值和 Secret Reference 形状，不含
  原始 DataForSEO 或 Google OAuth 凭据。
- production composition、配置 Schema、启动脚本和 Runbook 不依赖当前容器
  ID、数据库实例 UUID 或固定用户目录。

### 2.2 Worker 启动恢复

最终 Gate 发现旧 Worker 在恢复历史 Contact Enrichment 时持续占用 CPU。
修正限定在现有链路：

- Contact 页面文本与 JSON-LD 邮箱扫描改为有界 marker window，避免超长、
  无邮箱页面触发高代价正则扫描。
- Contact Enrichment 对页面尝试数设置现有 `maxPages` 的有界上限。
- Startup 恢复只重发真正 stranded 的当前版本事件，不增加既有
  `max_attempts`，并只统计实际写入 Outbox 的事件。
- 历史超时 Workflow 的迟到 completion 仍保留为警告，不创建重复业务事实。

修正后 Worker 10 秒 CPU 增量为 `0.234s`，`Responding=true`，
Working Set 约 `94.5 MB`；不再出现启动后的持续 CPU 循环。

## 3. 最终运行态

执行正常 Restart 后：

```text
runtimeMode=LOCAL_PRODUCT
Frontend=http://localhost:5173 -> HTTP 200
FastAPI=http://localhost:7200 -> HTTP 200
Private Core=http://127.0.0.1:7301 -> HTTP 200
PostgreSQL 18=healthy
Alembic head=20260806_0009
Backlinks migration head=0053
Temporal=healthy
Worker=running and responsive
DataForSEO enabled=true
DATAFORSEO_MAX_PAID_CALLS=250
DATAFORSEO_ABSOLUTE_BUDGET_MICROS=1000000
Gmail Send enabled=true
Gmail Sync enabled=true
Gmail polling interval=60 seconds
AI=false
Browser=false
```

DataForSEO 与 Gmail 任一侧的失败不会关闭另一侧。最终数据库中 DataForSEO
项目级、Provider 级以及 Gmail Send/Sync 项目级最新 Kill Switch 都是
`blocked=false`；其含义是当前版本放行，历史版本和紧急停止机制仍保留。

## 4. 真实 DataForSEO 脱敏证据

使用已有加密 Secret Reference：

```text
secret://growthos/local-product/dataforseo/***/v1
```

未记录 Login、Password、Authorization Header、完整请求 Payload 或原始 Secret
存储标识。

本轮最后一组真实 Profile 调度证据：

| Request | Endpoint | Provider 状态 | Ledger 状态 | estimated | actual | 创建时间 UTC |
| --- | --- | --- | --- | ---: | ---: | --- |
| `d1de3c1c...337d` | `/v3/backlinks/summary/live` | succeeded | settled | 27,600 | 24,036 | `2026-08-07 16:53:24.781610Z` |
| `738feddd...de88` | `/v3/backlinks/backlinks/live` | failed/time-out | settled-conservative | 27,600 | 27,600 | `2026-08-07 16:53:24.781610Z` |

第二条已经 dispatch，但未得到可证明的 Provider 结果。通过现有受治理操作按
reservation 金额保守结算为 `assumed_charged_at_reservation_no_provider_result`。
请求失败事实没有被改写，Ledger 没有悬空 reservation，也没有盲重试。

最近完整成功的 ElephTV Profile pair：

| Request | Endpoint | 状态 | actual micros | 创建时间 UTC |
| --- | --- | --- | ---: | --- |
| `d9c9e823...1710` | `/v3/backlinks/summary/live` | succeeded | 24,036 | `2026-08-07 16:29:17.008121Z` |
| `eebc4883...b096` | `/v3/backlinks/backlinks/live` | succeeded | 27,600 | `2026-08-07 16:29:17.008121Z` |

推荐补货也通过现有 Allowlist Endpoint 完成：

```text
c218d2e3...d6c5 referring_domains/live actual=27060
18b7f34b...ad84 competitors/live actual=24684
66ae2512...1cb7 referring_domains/live actual=27600
```

最终全局 Provider Request：`54`，其中 succeeded=`39`、failed=`15`、
running=`0`。失败历史被保留，不等同于重复付费或未处理 reservation。

## 5. 官方余额与 GrowthOS 内部预算

两者严格分开：

| 事实 | 最终值 |
| --- | --- |
| DataForSEO 官方账户余额 | 未查询；未知；不推断 |
| 当前 GrowthOS 周期 ID | `e1d0de0d...bea5` |
| 当前周期 limit | `1,000,000 micros` |
| 当前周期 spent | `182,616 micros` |
| 当前周期 reserved | `0` |
| 当前周期 remaining | `817,384 micros` |
| 当前周期 version | `15` |
| 全局历史 Ledger entries | `51` |
| 全局 settled / released / reserved | `49 / 2 / 0` |
| 全局 settled actual | `1,288,356 micros` |

历史预算周期完整保留：

| Budget | UTC 区间 | limit | spent | reserved | remaining |
| --- | --- | ---: | ---: | ---: | ---: |
| `166c54ac...1d67` | `2026-08-04 00:00` 至 `2026-08-07 06:45:20` | 100,000 | 82,800 | 0 | 17,200 |
| `7c56ef92...7517` | `2026-08-07 06:45:20` 至 `2026-08-07 07:22:11` | 100,000 | 27,600 | 0 | 72,400 |
| `8c2350a1...e320` | `2026-08-07 07:22:11` 至 `2026-08-07 15:45:48` | 1,000,000 | 995,340 | 0 | 4,660 |
| `e1d0de0d...bea5` | 自 `2026-08-07 15:45:48` 起 | 1,000,000 | 182,616 | 0 | 817,384 |

新周期通过治理命令打开，旧周期没有 SQL 清零、删除或覆盖。全局 Ledger 包含
保留项目与历史周期；当前 ElephTV 状态页显示的是项目级当前周期视图，不能与
全局历史合计混为同一指标，更不能当作 DataForSEO 官方账户余额。

## 6. 推荐数据结果

只有 `publication_status=PUBLISHED`、`verified_public_email_count>0` 且
`default_contact_email_reference IS NOT NULL` 的网站被发布。

| 项目 | Inventory | Published | 合规公开邮箱 Published |
| --- | ---: | ---: | ---: |
| AWOL | 30 | 8 | 8 |
| ElephTV | 82 | 16 | 16 |

AWOL 已发布域名：

```text
bizcommunity.com
homecinemasdubai.com
mountingmasters.co.za
newsdirectory3.com
reach.dog
stuff.co.za
themiddle.co
thesouthafrican.com
```

ElephTV 已发布域名：

```text
baitytax.com
dailypost.ng
evvnt.com
gauteng.news
hapakenya.com
makemoney.ng
motiontechinstallers.co.za
news365.co.za
pueblachristianschool.org
pulse.ng
samdb.co.za
satdigital.co.za
satellitemasters.co.za
sifpa.net
skiessolutionsgroup.com
terloops.co.za
```

结果文件不记录公开邮箱原文。不存在“先发布、后找邮箱”的条目。

## 7. 两项目 Profile、Inventory 与直接监控

| 项目 | Snapshot | total backlinks | referring domains | Inventory | Coverage | cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| AWOL | `0404c5fe...39d2` | 11,360 | 996 | 900 | 8.9641% | 51,636 |
| ElephTV | `1cfb72d6...fc66` | 610 | 127 | 501 | 97.6608% | 51,636 |

两个项目的 Context、Snapshot、Cursor、Inventory、Health 和下次同步均按
`website_project_id` 隔离。AWOL 最后一组分页调度部分失败时保留此前最新
fresh/partial Snapshot，没有用 ElephTV 数据补写，也没有发布无完整 Provider
pair 支撑的新 Snapshot。

直接链接监控继续使用现有静态 Crawler/HTML 证据链，不调用 DataForSEO：

```text
AWOL item=60f2f49f...02cc
run=92abb296...70ce
observation=43578221...a641
result=present / VALID

ElephTV item=6fdfa083...32c9
run=b9aedf99...e5ed
observation=4965cfeb...fbce
result=present / VALID
```

同一幂等键重放保持一个 Request、一个 Run、一个不可变 Observation。Links
页面分别显示站点整体 Profile/Inventory 与已登记链接直接监控，不再用当前
Candidate 分页数量冒充全局监控数量。

## 8. Gmail 与人工边界

- 同一组织级 Gmail Connection：`ce7b81a9...c737`
- 账号脱敏：`t***@gmail.com`
- ElephTV 与 AWOL binding：均为 `ACTIVE`、已选择
- Connection：`CONNECTED / AVAILABLE / sync capable`
- Gmail Send Runtime：enabled
- Gmail Sync Runtime：enabled
- Send Preflight：允许进入人工确认，delivery=`NOT_SENT`
- 当前 ElephTV：SendIntent=`0`、SendAttempt=`0`、Mail=`0`
- 当前 AWOL：SendIntent=`0`、SendAttempt=`0`、Mail=`0`

两个项目共享同一 Connection，但项目业务事实不共享。当前只有一个稳定
Gmail polling Workflow 在运行：

```text
workflowId=backlinks:11111111-1111-4111-8111-111111111111:
cec65d3f-92e5-4b13-aa26-7b39e74e213a:gmail-connection:
gmail-polling-sync:v1:ce7b81a9-9023-4a0b-a1ba-371dca9fc737
startTime=2026-08-07T15:50:17.183815Z
status=RUNNING
```

没有重复 Gmail Workflow，没有新邮件发送，没有重复邮件。数据库中的全局
历史 SendIntent/Attempt 属于其他隔离历史项目，不得作为 ElephTV/AWOL 本轮
发送证据。

## 9. 刷新、缓存、幂等与 Restart

桌面和 390px 页面各刷新两次前后：

```text
DataForSEO Provider Requests=50 -> 50
GrowthOS Ledger entries=47 -> 47
current-cycle spent=79344 -> 79344
duplicate paid calls from refresh=0
```

刷新验证之后发生的 Provider Request 是独立的到期 Profile 调度与受治理
补货，不是页面 GET、项目切换或刷新触发。页面读取继续使用 PostgreSQL、
Provider Cache、持久 Snapshot 和 Inventory。

正常 Restart 后：

- DataForSEO、Gmail Send、Gmail Sync 保持启用；
- CI/test 仍默认关闭真实 Provider；
- Provider Request、Ledger、Snapshot、Run、Observation、Send 和 Mail
  均未因 Restart 重复；
- Temporal 只保留一个稳定 Gmail polling Workflow；
- Worker 在不打开 Links 页面时继续恢复和调度持久任务。

## 10. 浏览器与产品交互

验证 URL：

```text
http://localhost:5173/projects/elephtv/performance/links
http://localhost:5173/projects/awolvision-com-4ec81dca/performance/links
```

截图：

```text
frontend/output/playwright/local-product-028-desktop-1440x1000.png
frontend/output/playwright/local-product-028-mobile-390x844.png
```

结果：

- Desktop `1440x1000` 和 Mobile `390x844` 无控件重叠或水平溢出。
- 项目切换、Recommendation、Opportunity、Gmail selector、Links Profile、
  Inventory 和直接监控均从真实 Gateway/Core 数据读取。
- “加入机会”保持当前页，不弹窗、不自动进入详情；新机会排在列表顶部，
  用户主动点击才进入详情。
- 加入机会不会自动启动 Draft；草稿由用户在 Opportunity 后续动作中发起。
- 键盘遍历、桌面、移动端和应用控制台检查通过。

## 11. 全量验证

Core：

```powershell
cd backend/core
npm run typecheck
npm run lint
npm run build
npm run verify:backlinks
```

结果：

```text
Typecheck/Lint/Build=PASS
Source manifest=28
License validation=693 packages
Backlinks OpenAPI=70 paths
Migrations=46 files through 0053
Unit=99 files / 536 tests
API=30 files / 103 tests
Contract=27 files / 171 tests
Integration=52 passed files, 4 skipped / 200 passed, 13 skipped tests
Security=9 files / 107 tests
Resilience=3 files / 8 tests
```

028 Worker 修正的聚焦回归：

```powershell
cd backend/core
npx vitest run test/security/contact-parser.test.ts `
  test/unit/contact-enrichment-command.test.ts --maxWorkers=1
```

结果：`2 files / 16 tests passed`。触及文件 ESLint、Typecheck 和 Build 均通过。

FastAPI：

```powershell
python -m ruff check backend/api
python -m pytest backend/api/tests -q
```

结果：Ruff=`PASS`；pytest=`71 passed, 1 skipped`。

Frontend：

```powershell
cd frontend
npm run typecheck
npm run lint
npm run build
node --test
npx playwright test test/outreach-desktop.spec.ts
npx playwright test test/outreach-mobile.spec.ts
npx playwright test test/outreach-keyboard-a11y.spec.ts
```

结果：

```text
Typecheck/Lint/Build=PASS
Source tests=47 passed
Desktop Playwright=5 passed
Mobile Playwright=1 passed
Keyboard Playwright=1 passed
```

PostgreSQL 18：

```powershell
.\backend\database\tests\verify-postgresql18.ps1
```

结果：

```text
clean install=PASS
historical upgrade=PASS
write compatibility=PASS
backup/restore=PASS
tables=98
persistent fact groups=3
RPO=0.422 seconds
RTO=88.593 seconds
Alembic head=20260806_0009
Backlinks head=0053
```

运行、可移植性与差异：

```powershell
.\Start-GrowthOS-LocalProduct.ps1 -PreflightOnly
.\ops\local-product\Restart-GrowthOS-LocalProduct.ps1
.\ops\local-product\Status-GrowthOS-LocalProduct.ps1 -Json
docker exec growthos-live001-temporal temporal workflow list `
  --address 127.0.0.1:7233 `
  --namespace growthos-backlinks-canary `
  --query "ExecutionStatus='Running'" --output json
git diff --check
git status --short
```

结果：

```text
real configuration preflight=PASS
clean missing-Secret fail-closed tests=PASS
normal Restart retention=PASS
runtime status=ok
running Temporal Workflows=1 Gmail polling
portable checked-in configuration scan=PASS
raw Secret scan=PASS
git diff --check=PASS
commit=false
push=false
```

## 12. 最终状态与剩余人工动作

```text
LOCAL-PRODUCT-028=PASS_LOCAL_REAL_READY
DataForSEO=enabled
Gmail Send=enabled
Gmail Sync=enabled
refresh duplicate paid calls=0
official DataForSEO balance queried=false
current internal spent=182616
current internal remaining=817384
global ledger settled actual=1288356
AWOL published/compliant=8/8
ElephTV published/compliant=16/16
PostgreSQL=healthy
Temporal=healthy
Worker=running and responsive
commit=false
push=false
QUALITY-BACKLOG-001 executed=false
```

最多两个剩余人工动作：

1. 用户在草稿审阅后执行最终发送确认。
2. 收件方真实回复，随后由现有 Gmail Sync 闭环。

服务保持运行。
