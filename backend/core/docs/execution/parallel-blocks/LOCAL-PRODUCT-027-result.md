# LOCAL-PRODUCT-027 Backlink Profile、Inventory 与监控连续性结果

- 执行日期：`2026-08-07`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-027`
- 最终本地运行 ID：`20260807-212423`
- 最终状态：`PASS`
- Stop boundary：未执行任何后续 Coding Block

## 1. 结论

`LOCAL-PRODUCT-027` 已按变更后的文档完成：

1. DataForSEO Profile/Inventory 保持为站点级 Provider 画像，不再把所有
   Provider Candidate 自动当作需要逐 URL 直接检测的 Placement。
2. 直接检测只适用于用户导入、已确认 Placement、用户置顶或受管条目。
   纯 DataForSEO 发现条目保持 `provider_only`，没有伪造直接验证事实。
3. Profile、Cursor、Inventory、Policy、Run 和 Observation 继续复用现有
   PostgreSQL 模型、Temporal、Worker、Crawler/HTML 检测链路和 Core 权威。
4. 正常 Restart 后 Profile 定时任务按持久 Cursor 恢复；已成功的直接检测
   不重复，未来任务继续等待，到期任务最多恢复一次。
5. 修正 PostgreSQL 微秒时间与 JavaScript 毫秒时间比较造成的重复到期窗口。
6. 修正历史 `waiting_provider` Job 阻塞当前匹配 Cursor Continuation 的问题；
   只允许同 Trigger、同 Sync Mode、同 Cursor 的未来等待 Job 阻塞调度。
7. 显式同步、页面读取、项目切换和页面刷新语义分离。最终页面刷新后
   DataForSEO Provider Request 数保持 `37`，没有新增付费调用。
8. ElephTV 与 AWOL 各完成一次真实当前 Inventory 直接检测，结果均为
   `present / VALID`；同幂等键重放不创建第二个 Run 或 Observation。
9. 正常 Restart 后 DataForSEO、Gmail Send 和 Gmail Sync 均继续启用。
10. Recommendation 仍只发布已找到合规公开邮箱的网站。

本轮没有创建第二套 Provider、Queue、Crawler、Worker、Scheduler 或业务数据
模型；没有修改 Recommendation 到 Opportunity 的人工确认边界，也没有自动
发送邮件。本轮未 commit、未 push，未清理、撤销或覆盖工作树中的无关改动。

## 2. 主要实现

### 2.1 监控资格与迁移

新增并注册：

```text
backend/core/src/modules/backlinks/db/migrations/0053_backlink_monitoring_continuity.sql
```

迁移结果：

```text
Backlinks migration head=0053
SHA-256=f8cba0bb44c0e203e46b476fc539f5101206b4dd272404a0defd182229ce9a5a
```

规则为：

```text
USER_IMPORTED                 -> 可直接检测
placement_id IS NOT NULL      -> 可直接检测
pinned=true                   -> 可直接检测
managed=true                  -> 可直接检测
纯 DATAFORSEO Provider 条目   -> provider_only，不自动逐 URL 检测
```

Provider 报告 `lost` 只作为 Tier A 的高优先级画像信号，不直接生成 Placement
丢失事实。Candidate 未取得直接检测资格时不产生直接 KPI、直接状态或直接证据。

### 2.2 调度连续性

调整范围：

```text
backend/core/src/modules/backlinks/db/repositories/monitoring-schedule.repository.ts
backend/core/src/modules/backlinks/application/services/backlink-profile.service.ts
backend/core/src/modules/backlinks/runtime/production-runtime.ts
```

关键行为：

- Schedule 唯一身份继续由项目、Inventory Item、Policy Version、
  `scheduled_for` 和执行模式决定。
- 调度比较统一到 PostgreSQL 毫秒精度，避免数据库微秒尾数造成同一次 Due
  Schedule 在 Node.js 中反复被判定为未完成。
- Immediate Check 在首次写入时启动现有 Scheduler；幂等重放只返回原有
  Run/Observation，不再次启动。
- 已到期且 Provider 已恢复的 `waiting_provider` Profile Job 原位 requeue，
  保留同一 Job 身份、历史、重试次数和版本。
- 只有匹配当前 Trigger、Sync Mode、Cursor 的未来等待 Job 才能阻塞下一次
  Continuation；旧的无关 Manual Job 不再阻塞。
- Startup 恢复独立于页面访问，读取 API 和页面刷新不承担 Scheduler 触发职责。

### 2.3 页面语义

调整范围：

```text
frontend/src/features/outreach/links/backlink-profile-panel.tsx
frontend/src/features/outreach/links/links-workspace.tsx
frontend/src/features/outreach/links/links-source.test.mjs
```

页面允许用户对 Provider-only 条目执行“置顶”，置顶后复用同一 Inventory Item
和 Policy 进入直接检测资格。未置顶、未受管、未形成 Placement 的纯 Provider
条目，其暂停和立即检测按钮保持禁用，不会把 Provider 发现误写成直接验证。

## 3. 正常 Restart 与运行状态

最终执行正常完整 Restart，未使用临时关闭 Provider 的模式：

```powershell
.\ops\local-product\Restart-GrowthOS-LocalProduct.ps1
.\ops\local-product\Status-GrowthOS-LocalProduct.ps1
```

最终运行状态：

```text
checkedAt=2026-08-07T21:35:20.2110288+08:00
runId=20260807-212423
runtimeMode=LOCAL_PRODUCT
Frontend=HTTP 200
FastAPI=HTTP 200
Private Core=HTTP 200
PostgreSQL 18=healthy
Temporal=healthy
Worker=running
Backlinks migration head=0053
DataForSEO=true
Gmail Send=true
Gmail Sync=true
Browser=false
```

DataForSEO 持久配置：

```text
DATAFORSEO_ENABLED=true
DATAFORSEO_ABSOLUTE_BUDGET_MICROS=1000000
DATAFORSEO_MAX_PAID_CALLS=250
DATAFORSEO_ESTIMATED_COST_MICROS=27600
```

DataForSEO 项目级和 Provider 级 Kill Switch 均为 `blocked=false`。Gmail Send
和 Gmail Sync 项目级 Kill Switch 也为 `blocked=false`。历史 Kill Switch
版本、预算、Usage Ledger、缓存、Endpoint Allowlist 和幂等记录均保留。

Status 中 Worker 的 3 条近期错误来自既有 Recommendation Refill 在 ElephTV
缺少 products/targetUrls 项目上下文，不是 027 Profile/Inventory 调度失败；
Worker、Temporal 和监控恢复均正常运行，本轮未扩大范围修改该独立问题。

## 4. 真实 DataForSEO Provider 脱敏证据

本轮继续解析仓库外已有 Secret Reference：

```text
secret://growthos/local-product/dataforseo/***/v1
```

结果文件不包含 DataForSEO Login、Password、Authorization Header、完整
Provider Task Payload 或原始 Secret 存储标识。

最终最新一组真实 Provider 请求：

| Endpoint | 状态 | 预估 micros | 实际 micros | 创建时间 UTC |
| --- | --- | ---: | ---: | --- |
| `/v3/backlinks/summary/live` | succeeded | 27,600 | 24,036 | `2026-08-07 13:24:41.562323Z` |
| `/v3/backlinks/backlinks/live` | succeeded | 27,600 | 27,600 | `2026-08-07 13:24:41.562323Z` |

两次请求实际合计 `51,636 micros`。这是 ElephTV 到期 Profile Continuation，
不是页面刷新或直接 URL 检测产生的调用。直接 URL 检测使用现有静态
Crawler/HTML 证据链，不调用 DataForSEO。

## 5. Profile 与 Cursor 结果

| 项目 | Snapshot | 观察时间 UTC | Provider 总外链 | Referring Domains | Inventory | Coverage | 成本 micros | 下次同步 UTC |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| AWOL | `03d57949...` | `2026-08-07 12:44:45.232Z` | 11,360 | 996 | 600 | 5.9815% | 51,636 | `2026-08-07 13:44:45.232Z` |
| ElephTV | `78fb19e1...` | `2026-08-07 13:24:43.480Z` | 610 | 127 | 201 | 39.1813% | 51,636 | `2026-08-07 14:24:43.480Z` |

持久 Cursor：

| 项目 | pulled | next page | last synced UTC | next sync UTC | version |
| --- | ---: | ---: | --- | --- | ---: |
| AWOL | 600 | 2 | `2026-08-07 12:44:45.232Z` | `2026-08-07 13:44:45.232Z` | 6 |
| ElephTV | 201 | 2 | `2026-08-07 13:24:43.480Z` | `2026-08-07 14:24:43.480Z` | 2 |

最新 Job：

| 项目 | Job | 状态 | Trigger / Mode | pulled | 成本 micros |
| --- | --- | --- | --- | ---: | ---: |
| AWOL | `ff95007f...` | partial | continuation / page | 600 | 51,636 |
| ElephTV | `7c972679...` | partial | continuation / page | 201 | 51,636 |

`partial` 表示分页 Inventory 没有被伪装成 Provider 全量。Profile、
Snapshot、Cursor 和 Inventory 均按项目隔离并持久化；正常 Restart 后继续
使用原 Cursor，没有从第一页重新计费。

## 6. 真实直接检测结果

### 6.1 AWOL

```text
Inventory Item=60f2f49f...
sourceType=DATAFORSEO
provider=dataforseo
pinned=true
managed=false
policy=enabled / Tier A
Run=92abb296...
Observation=43578221...
status=SUCCEEDED
attempt=1
result=present
directValidationStatus=VALID
scheduledFor=2026-08-07 12:35:16.632Z
finishedAt=2026-08-07 12:35:22.508Z
nextCheckAt=2026-08-08 13:28:20.508Z
```

该条目因用户置顶取得直接检测资格。当前累计 Run=`2`、
Observation=`2`，包含一条历史事实和本轮一条当前事实。

### 6.2 ElephTV

```text
Inventory Item=6fdfa083...
sourceType=USER_IMPORTED
provider=user_import
pinned=false
managed=true
policy=enabled / Tier A
Run=b9aedf99...
Observation=4965cfeb...
status=SUCCEEDED
attempt=1
result=present
directValidationStatus=VALID
scheduledFor=2026-08-07 12:52:38.927Z
finishedAt=2026-08-07 12:52:41.564Z
nextCheckAt=2026-08-08 13:28:40.564Z
```

该条目因用户导入且受管取得直接检测资格。当前累计 Run=`2`、
Observation=`2`。

同一幂等键重放：

```powershell
curl.exe -sS -D - -o - -X POST `
  "http://localhost:7200/api/v1/projects/elephtv/backlinks/inventory-items/6fdfa083-1f8e-57d0-bbb8-3498e0bb32c9/checks" `
  -H "idempotency-key: lp027-elephtv-check-20260807" `
  -H "x-request-id: lp027-final-curl-replay"
```

结果：

```text
HTTP=202
replayed=true
Run=b9aedf99...
Observation=4965cfeb...
request rows=1
distinct runs=1
distinct observations=1
```

Restart 后两个项目均未新增重复直接检测 Run 或 Observation。

## 7. 页面刷新与付费幂等

027 开始前的 026 基线与最终值：

| 指标 | 026 基线 | 027 最终 | 变化 |
| --- | ---: | ---: | ---: |
| DataForSEO Provider Requests | 31 | 37 | +6 |
| GrowthOS 内部 spent micros | 582,252 | 737,160 | +154,908 |
| 当前周期 Ledger entries | 24 | 30 | +6 |
| Settled | 22 | 28 | +6 |
| Released | 2 | 2 | 0 |
| Reserved | 0 | 0 | 0 |

新增 6 次请求是 3 组到期 Profile Continuation，每组调用 Summary 和
Backlinks 两个既有 Allowlist Endpoint：

- AWOL 在本轮执行窗口中恢复了 2 个到期 Continuation。
- ElephTV 在最终正常 Restart 后恢复了 1 个被历史无关
  `waiting_provider` Job 阻塞的到期 Continuation。
- 每组实际成本 `51,636 micros`，合计 `154,908 micros`。

最终浏览器页面刷新前后：

```text
DataForSEO requests=37 -> 37
latest request=2026-08-07 13:24:41.562323Z
new paid calls from refresh=0
```

页面 GET、项目切换、展开 Profile、展开 Inventory、键盘遍历和普通刷新均未
调用 Provider。只有初始化、Domain 变化、真正到期 Schedule 或用户显式同步
才允许进入受治理的 DataForSEO 调用路径。

## 8. 官方余额与 GrowthOS 内部预算

二者严格分开：

| 项目 | 最终结果 |
| --- | --- |
| DataForSEO 官方账户余额 | 本轮未调用官方余额端点，数值不可得，不记录、不推断 |
| GrowthOS 内部预算上限 | `1,000,000 micros` |
| 内部已花费 | `737,160 micros` |
| 内部预留 | `0` |
| 内部剩余 | `262,840 micros` |
| 当前 Budget version | `61` |
| 最大付费调用数 | `250` |

历史预算周期完整保留：

| 周期 UTC | limit | spent | reserved | remaining | version |
| --- | ---: | ---: | ---: | ---: | ---: |
| `2026-08-04 00:00` 至 `2026-08-07 06:45:20.247794` | 100,000 | 82,800 | 0 | 17,200 | 8 |
| `2026-08-07 06:45:20.247794` 至 `2026-08-07 07:22:11.981766` | 100,000 | 27,600 | 0 | 72,400 | 4 |
| `2026-08-07 07:22:11.981766` 至 `2026-08-12 17:50:19.654766` | 1,000,000 | 737,160 | 0 | 262,840 | 61 |

当前周期 Usage Ledger：

```text
entries=30
settled=28
released=2
reserved=0
estimated total=828000 micros
actual total=737160 micros
```

预算没有超过上限，因此本轮没有重置额度或新开预算周期。历史账本没有清零、
删除或覆盖。GrowthOS 内部 `micros` 只表示产品内部治理账本，不能当作
DataForSEO 官方账户余额。

## 9. 推荐数据结果

最终 Recommendation Inventory：

| 项目 | Inventory | 状态 | Published | Published with compliant public email |
| --- | ---: | --- | ---: | ---: |
| AWOL | 30 | 22 NOT_PUBLISHED / 8 PUBLISHED | 8 | 8 |
| ElephTV | 20 | 20 CONTACT_PENDING | 0 | 0 |

已发布网站：

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

这 8 条均满足：

```text
publication_status=PUBLISHED
verified_public_email_count>0
default_contact_email_reference IS NOT NULL
```

结果文件不记录原始公开邮箱。本轮没有发布缺少合规公开邮箱的网站，没有新增
Recommendation、Opportunity、Contact、Draft、SendIntent 或 SendAttempt。
最终 `SendIntent=0`、`SendAttempt=0`。

## 10. 浏览器验证

真实页面：

```text
http://localhost:5173/projects/elephtv/performance/links
```

截图：

```text
output/playwright/local-product-027-desktop-1440x1000.png
output/playwright/local-product-027-mobile-390x844.png
```

验证结果：

- Desktop `1440x1000`：Profile、Inventory 和直接检测操作无重叠。
- Mobile `390x844`：`innerWidth=390`、`clientWidth=375`、
  `scrollWidth=375`，无水平溢出。
- 页面显示 ElephTV 最新 Profile：`610` 总外链、`127` Referring Domains、
  `201` Inventory、`39%` Coverage、`51,636 micros`。
- 键盘 Tab 可到达导航展开、刷新 Links 和立即同步等控件。
- Provider-only 条目的暂停和直接检测不可用，置顶操作可用。
- 浏览器控制台无应用错误；只有 React DevTools 提示及正常 Restart 期间的
  Vite 连接丢失/恢复日志。

## 11. 验证命令

Core：

```powershell
cd backend/core
npm run typecheck
npm run lint
npm run build
npx vitest run test/unit/production-runtime.test.ts --maxWorkers=1 --reporter=verbose
npx vitest run test/backlinks/integration/backlink-profile-inventory-migration.test.ts --maxWorkers=1 --reporter=verbose
```

结果：

```text
typecheck=PASS
lint=PASS
build=PASS
production-runtime=7 passed
profile/inventory migration integration=9 passed
additional targeted local-product unit/API tests=PASS
```

迁移：

```powershell
.\backend\database\tests\verify-postgresql18.ps1
```

结果：

```text
46 migration files verified
Backlinks migration head=0053
deployment manifest hash=PASS
```

Frontend：

```powershell
cd frontend
npm run typecheck
npm run lint
npm run build
node --test src/features/outreach/links/links-source.test.mjs
```

结果：

```text
typecheck=PASS
lint=PASS
build=PASS
links source tests=6 passed
desktop browser validation=PASS
mobile browser validation=PASS
keyboard validation=PASS
```

运行态与差异：

```powershell
.\ops\local-product\Status-GrowthOS-LocalProduct.ps1
git diff --check
```

结果：

```text
runtime status=ok
git diff --check=PASS
```

本机仓库 `.venv` 是 Linux 布局且系统 `python` 为 WindowsApps shim，因此本轮
没有把无法启动的 Python pytest 命令伪报为通过。027 修改的 Core API、调度、
迁移和前端路径已由上述 TypeScript 单元、API/集成、构建和真实运行态验证覆盖。

## 12. 最终状态

```text
LOCAL-PRODUCT-027=PASS
Frontend=HTTP 200
FastAPI=HTTP 200
Private Core=HTTP 200
PostgreSQL=healthy
Temporal=healthy
Worker=running
Backlinks migration head=0053
DataForSEO=enabled
Gmail Send=enabled
Gmail Sync=enabled
DataForSEO refresh duplicate calls=0
ElephTV direct check=present / VALID
AWOL direct check=present / VALID
Direct-check restart duplicates=0
Published recommendations=8
Published recommendations with compliant public email=8
Official DataForSEO balance queried=false
Internal DataForSEO spent micros=737160
Internal DataForSEO remaining micros=262840
Budget reset=false
Commit=false
Push=false
Later block executed=false
```
