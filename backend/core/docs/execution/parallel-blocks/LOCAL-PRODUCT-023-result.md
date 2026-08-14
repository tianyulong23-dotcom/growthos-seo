# LOCAL-PRODUCT-023 真实 DataForSEO 发现与本地运行配置持久化结果

- 执行日期：`2026-08-07`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-023`
- 最终状态：`PASS`
- 最终运行 ID：`20260807-161829`
- Stop boundary：未执行 `LOCAL-PRODUCT-024..027`

## 1. 结论

`LOCAL-PRODUCT-023` 已完成：

1. 使用仓库外已有 DataForSEO Secret Reference 执行了真实受治理请求，没有要求用户补充候选池。
2. GrowthOS 内部 DataForSEO 新周期上限为 `1,000,000 micros`，`DATAFORSEO_MAX_PAID_CALLS=250`。
3. 旧的 `100,000 micros` 周期和历史 Ledger 完整保留；没有手工 SQL 清零或改写历史消费。
4. ElephTV 与 AWOL 分别形成真实 Profile Snapshot、Inventory 和监控策略，没有跨项目复制数据。
5. AWOL 的真实发现进入已有 Candidate/Inventory/Recommendation 流程。
6. Recommendation API 当前只返回已通过公开邮箱门禁的 4 个本轮推荐网站。
7. 正常本地 Restart 后 DataForSEO 继续启用；推荐页面连续刷新不增加付费请求。
8. 同一补货触发重复提交返回同一 Job，不产生第二组付费请求。
9. 保留现有 Provider、Temporal、PostgreSQL、预算 Ledger、缓存接口、幂等、Endpoint Allowlist 和 Kill Switch；没有新增第二套 Provider、Queue、Crawler、Worker 或业务数据模型。

本轮未 commit、未 push、未清理或撤销工作树中的无关改动。

## 2. 官方账户与内部预算分离

| 项目 | 事实 |
| --- | --- |
| DataForSEO 官方账户余额 | 用户已确认仍有可用余额；本轮没有调用账户余额接口，因此不记录或推测官方余额数值 |
| GrowthOS 内部周期预算 | `1,000,000 micros` |
| 单次请求预估成本 | `27,600 micros` |
| 最大付费调用数 | `250` |
| 当前内部已消费 | `427,344 micros` |
| 当前内部预留 | `0 micros` |
| 当前内部剩余 | `572,656 micros` |
| 70% 告警线 | `700,000 micros`，当前未达到 |
| 100% 硬停止 | `1,000,000 micros`，预算硬停止逻辑保留 |

`1,000,000 micros` 只代表 GrowthOS 的内部治理上限，不代表 DataForSEO 官方账户余额，也不代表必须消费的金额。

## 3. Runtime、Secret 与治理状态

正常 Restart 后的最终状态：

```text
Frontend:    http://localhost:5173          HTTP 200
FastAPI:     http://localhost:7200/health   HTTP 200
Private Core:http://127.0.0.1:7301/health   HTTP 200
PostgreSQL:  healthy
Temporal:    healthy
Core API:    running
Core Worker: running
DataForSEO:  enabled
```

脱敏 Secret Reference：

```text
secret://growthos/local-product/dataforseo/***/v1
```

API 与 Worker 的持久化 Runtime 配置均为：

```text
DATAFORSEO_ENABLED=true
DATAFORSEO_ABSOLUTE_BUDGET_MICROS=1000000
DATAFORSEO_MAX_PAID_CALLS=250
DATAFORSEO_REQUEST_TIMEOUT_MS=120000
DATAFORSEO_ESTIMATED_COST_MICROS=27600
```

最终 Status 同时显示：

```text
absoluteBudgetMicros=1000000
maxPaidCalls=250
estimatedCostMicros=27600
candidateLimit=100
```

当前项目的 DataForSEO Project/Provider Kill Switch 均为 `blocked=false`。Kill Switch 表、版本历史和人工暂停/恢复入口均保留。

实际启用的最小 Endpoint Allowlist 为：

```text
/v3/serp/google/organic/task_post
/v3/serp/google/organic/tasks_ready
/v3/serp/google/organic/task_get/advanced
/v3/dataforseo_labs/google/competitors_domain/live
/v3/backlinks/competitors/live
/v3/backlinks/referring_domains/live
/v3/backlinks/summary/live
/v3/backlinks/backlinks/live
```

未开放任意通配 Endpoint。Provider Cache 的现有表和读写路径保留；本轮真实成功不依赖缓存命中，最终 DataForSEO cache entry 数为 `0`。

## 4. 预算周期与历史 Ledger

预算周期终态：

| Budget ID | 上限 | 已消费 | 已预留 | 状态 |
| --- | ---: | ---: | ---: | --- |
| `166c54ac…1d67` | 100,000 | 82,800 | 0 | 历史周期，已结束 |
| `7c56ef92…7517` | 100,000 | 27,600 | 0 | 历史周期，已结束 |
| `8c2350a1…e320` | 1,000,000 | 427,344 | 0 | 当前周期 |

新周期通过受治理脚本原子关闭旧周期并创建：

```text
Open-GrowthOS-LocalProductDataForSeoBudgetCycle.ps1
ops/local-product/Open-GrowthOS-LocalProductDataForSeoBudgetCycle.ps1
```

新周期创建时从 `spent=0`、`reserved=0` 开始。创建后预算周期总数为 `3`；创建前的历史 Ledger 为 `4` 条，历史已结算实际成本为 `110,400 micros`，均被保留。

当前新周期 Ledger：

```text
entries:         18
settled:         16
released:         2
actual settled: 427344 micros
reserved:          0
unknown_charge:    0
```

本轮成本轨迹：

| 阶段 | 实际结算 | 说明 |
| --- | ---: | --- |
| Profile v1 | 103,272 | Summary 返回成功；Inventory 超时后的未知结果按最保守方式结算，没有伪造结果 |
| Profile v2 | 55,200 | 两个已派发 Summary 按保守方式结算；两个未形成可计费结果的 Inventory reservation 释放，共释放估算 55,200 |
| Profile v3 | 103,272 | ElephTV/AWOL Summary 与 Inventory 全部成功 |
| 标准 SERP 队列尝试 | 82,800 | 3 次 task_post 后在本地有限轮询窗口内未 ready，均进入失败并保守结算 |
| 最终同步发现 | 82,800 | 3 次真实 live 请求成功 |
| 合计 | 427,344 | 与当前 Budget `spent_micros` 一致 |

新增的对账脚本只处理已有 Ledger/Request/Lease/Job：

```text
Resolve-GrowthOS-LocalProductDataForSeoUnknownCharge.ps1
ops/local-product/Resolve-GrowthOS-LocalProductDataForSeoUnknownCharge.ps1
```

它不会删除历史，也不会为未知 Provider 结果生成虚假 Candidate、Artifact 或 Recommendation。最终没有未决 reservation 或 `unknown_charge`。

## 5. 真实 Provider 脱敏证据

### 5.1 推荐发现

AWOL 最终成功发现使用现有项目画像：

```text
project:        awolvision.com
context ID:     06420fcb-7dfc-4e53-9928-17a434d13ad4
country/locale: US / en
product:        Home cinema projector
keyword:        home cinema
target URL:     https://awolvision.com/
discovery target: showmax.com
```

最终成功的 3 个真实 Provider 请求：

| 脱敏 Request ID | Endpoint | UTC 时间 | 实际成本 | 结果 |
| --- | --- | --- | ---: | --- |
| `d0bf02d9…8956` | `/v3/backlinks/referring_domains/live` | `08:20:00.523` - `08:20:04.039` | 27,600 | succeeded |
| `6fb00672…23ba` | `/v3/backlinks/competitors/live` | `08:20:04.067` - `08:20:06.179` | 27,600 | succeeded |
| `0ed705ae…d8d3` | `/v3/backlinks/referring_domains/live` | `08:20:06.189` - `08:20:06.683` | 27,600 | succeeded |

对应脱敏 Provider Task ID：

```text
08070820…8782
08070820…c76a
08070820…49ab
```

内部 Job 与 Batch：

```text
Recommendation Job: 646782d2-e560-437c-b3e0-7161b2153322
Discovery Batch:    9ff7d0d9-b90e-4f34-baa8-4a51525730f7
Provider cost:      82800 micros
Provider source:    provider
Added candidates:   9
Evaluation:         ready=9, excluded=0, evaluated=10, insufficientData=1
```

使用的是已有商业发现来源：

```text
EXISTING_HISTORY
VERIFIED_COMPETITOR_REFERRING_DOMAINS
VERIFIED_COMPETITOR_BACKLINK_GAP
USER_REFERRING_DOMAINS
```

当已有可验证 competitor domain 时，最终计划直接使用同步 live Endpoint；标准 SERP 队列只保留为没有 verified competitor 时的现有 fallback，避免再次为同一可完成发现追加排队付费调用。

### 5.2 Backlink Profile

Profile 成功调用的脱敏 Provider Task：

```text
AWOL Summary:    08070743…77fe
AWOL Inventory:  08070743…7af1
ElephTV Summary: 08070744…511e
ElephTV Inventory:08070744…9aaa
```

## 6. ElephTV 与 AWOL Profile 结果

| 项目 | Profile Job | 状态 | Provider 总外链 | Referring Domains | Nofollow | Inventory | Coverage | 实际成本 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AWOL | `c1e379a1-4991-49f5-828f-a2540520233a` | partial | 11,360 | 996 | 1,499 | 100 | 0.9969% | 51,636 |
| ElephTV | `6f514ad2-c05f-450b-b8f2-2cfd7d967fdd` | partial | 610 | 127 | 48 | 101 | 19.6881% | 51,636 |

`partial` 表示受控分页库存没有假装成 Provider 全量，不表示初始化失败。两者均已形成各自独立的：

- `backlink_profile_sync_jobs`
- `backlink_profile_snapshots`
- `backlink_profile_health_snapshots`
- `backlink_inventory_items`
- `backlink_inventory_monitor_policies`
- `backlink_profile_sync_cursors`

AWOL Inventory 为 `100/100` DataForSEO，监控策略启用 `100/100`。ElephTV Inventory 为 `100/101` DataForSEO、`101/101` 有直接健康状态，监控策略启用 `101/101`。两项目的 Health 均保持 `INSUFFICIENT_DATA`，没有为不可用指标伪造数值。

历史失败 Job 和旧 `waiting_provider` 事实没有删除或重写；当前 v3 Job 和 Snapshot 是本轮成功验收事实。

## 7. 推荐 API 与公开邮箱门禁

最终真实 Gateway 调用：

```text
GET /api/v1/projects/awolvision-com-4ec81dca/backlinks/recommendations?status=ready&limit=100
```

当前画像版本返回 `4` 个 Recommendation，全部满足：

```text
publicationStatus=PUBLISHED
verifiedPublicEmailCount=1
canCreateOpportunity=true
```

| 推荐网站 | 脱敏公开邮箱 | 置信度 | 提取方式 | 公开证据页 |
| --- | --- | ---: | --- | --- |
| `stuff.co.za` | `s***@stuff.co.za` | 80 | visible_text | `https://stuff.co.za/category/news/app-news/page/2/` |
| `bizcommunity.com` | `s***@bizcommunity.com` | 90 | mailto | `https://www.bizcommunity.com/SubmitNews.aspx` |
| `thesouthafrican.com` | `i***@thesouthafrican.com` | 90 | mailto | `https://www.thesouthafrican.com/contact-us/` |
| `mountingmasters.co.za` | `i***@mountingmasters.co.za` | 80 | visible_text | `https://mountingmasters.co.za/dstv-greenstone-hill/` |

数据库总库存终态：

```text
PUBLISHED + verified email 1: 8
CONTACT_PENDING + email 0:   1
NOT_PUBLISHED + email 0:    21
```

其中 4 条是本轮当前画像新发布结果，另外 4 条为已保留的历史合规结果。只有表单、登录墙、验证码、拒绝访问或无公开邮箱的候选继续保留在未发布库存及原因统计中，不会进入当前 Recommendation API。

Contact Batch `97c7b568-0645-4e85-b024-9e7631e6da53` 在最终读取时为 `29/30` terminal、`8` published、`22` unpublished；剩余 1 个联系证据 Job 属于既有持久工作流，不是 DataForSEO 付费调用，也不会绕过公开邮箱门禁。

## 8. Links 页面语义

真实浏览器验证页面：

```text
http://localhost:5173/projects/awolvision-com-4ec81dca/performance/links
```

页面分别展示：

- 当前页 Candidate/Placement 成功记录，并明确“当前页成功记录 0”只限定当前 Candidate 视图。
- 独立的 Backlink Profile，显示 Provider 总量、Referring Domains、Nofollow、Inventory coverage、成本和 Health。
- 独立的 Inventory 表，显示 DataForSEO Provider、直接验证状态、监控 Tier、启用状态和下次检查。
- Candidate、Confirmed、Changed、Lost、Recovered 状态，不把 Recommendation Candidate 当作 Placement。

AWOL 页面可见真实 Profile 为 `11,360 backlinks / 996 referring domains / inventory 100 / cost 51,636 of 55,200`，没有因为默认 Candidate 视图而把全局 Profile/Inventory 显示成 `0`。

## 9. 刷新、幂等与 Restart 证据

### 页面刷新

在 Recommendation 页面连续执行 3 次浏览器 reload。

刷新前后数据库完全一致：

```text
budget spent:       427344 -> 427344
budget reserved:         0 -> 0
current ledger:         18 -> 18
settled ledger:         16 -> 16
released ledger:         2 -> 2
provider requests:      18 -> 18
```

浏览器只产生 Recommendation Inventory 和 Recommendation 的 GET 请求，没有 `/v3/` Provider 请求，也没有自动提交 refill。刷新验证开始后新增 Provider Request 数为 `0`。

### 同键重放

相同触发键：

```text
local-product-023-awol-live-v4-20260807-1619
```

第一次提交返回：

```text
jobId=646782d2-e560-437c-b3e0-7161b2153322
replayed=false
```

第二次提交返回同一 Job：

```text
jobId=646782d2-e560-437c-b3e0-7161b2153322
replayed=true
```

第二次提交没有新增 Provider Request 或 Ledger reservation。

### 正常 Restart

执行无额外 Provider 参数的：

```powershell
.\Start-GrowthOS-LocalProduct.ps1
```

最终运行 ID 为 `20260807-161829`。Restart 后 API 与 Worker 均恢复：

```text
DATAFORSEO_ENABLED=true
DATAFORSEO_ABSOLUTE_BUDGET_MICROS=1000000
DATAFORSEO_MAX_PAID_CALLS=250
```

测试/CI/无 Secret 环境的 fail-closed 行为未改变。

## 10. 定向验证

Core 定向测试：

```powershell
cd backend/core
npx vitest run test/unit/commercial-discovery-source.test.ts test/unit/commercial-official-runtime.test.ts test/unit/recommendation-refill-reservation.test.ts test/unit/production-runtime.test.ts test/unit/local-product-process-scripts.test.ts test/unit/backlink-profile-health.test.ts test/contract/dataforseo-profile-official-adapter.test.ts
```

结果：

```text
7 files passed
40 tests passed
```

Core Typecheck、Lint、Build：

```powershell
npm run typecheck
npx eslint src/modules/backlinks/adapters/dataforseo/commercial-official-runtime.ts src/modules/backlinks/runtime/local-product-backlink-profile-runtime.ts src/modules/backlinks/application/services/recommendation-refill-reservation.service.ts src/modules/backlinks/runtime/production-runtime.ts src/modules/backlinks/domain/recommendations/commercial-discovery-source.ts test/unit/commercial-official-runtime.test.ts test/unit/commercial-discovery-source.test.ts test/unit/recommendation-refill-reservation.test.ts test/unit/production-runtime.test.ts test/unit/local-product-process-scripts.test.ts
npm run build
```

结果：全部 PASS。

Frontend：

```powershell
cd frontend
node --test src/features/outreach/links/links-source.test.mjs
npm run build
```

结果：

```text
Links source tests: 6/6 PASS
TypeScript/Vite build: PASS
```

Vite 只有现有大 chunk warning，没有 build failure。

PowerShell：

```text
Start/Budget Cycle/Reconcile 的 6 个 root/ops 脚本 Parser PASS
```

运行态：

```powershell
.\Status-GrowthOS-LocalProduct.ps1 -Json
```

结果：`status=ok`，Frontend/FastAPI/Core HTTP 200，PostgreSQL/Temporal healthy，DataForSEO enabled。

差异检查：

```powershell
git diff --check
```

结果：PASS，仅有工作树已有的 LF/CRLF warning。

## 11. 本轮最小实现范围

本轮只在现有边界内补齐：

- 正常 Start/Restart 的 DataForSEO 启用状态与最大调用数恢复。
- 受治理的新预算周期脚本和未知费用对账脚本。
- 官方 Runtime 的语义状态检查与有限轮询。
- 已有 competitor 时优先使用同步 live 来源，保留无 competitor 时的原 SERP fallback。
- Profile Job 终态和分页 Artifact 身份稳定化。
- Recommendation ready 计数按当前画像版本隔离。
- 定向测试和本地 Runbook。

未新增迁移、共享 Contract、Provider Registry、Queue、Crawler、Browser Launcher、业务表或第二套业务权威。

## 12. 最终边界

最终状态为：

```text
PASS
```

本轮已经完成并停止。未执行 `LOCAL-PRODUCT-024`、`LOCAL-PRODUCT-025`、`LOCAL-PRODUCT-026` 或 `LOCAL-PRODUCT-027`。
