# LOCAL-REAL-002 持续推荐池与真实 DataForSEO 结果

- 执行日期：`2026-08-04`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-REAL-002`
- 阶段结果：`COMPLETED`
- 当前本地产品：`RUNNING`
- 公共入口：`http://localhost:5173`
- 最终运行 ID：`20260804-170624`

## 1. 分级结论

| 状态 | 结论 |
| --- | --- |
| `IMPLEMENTED` | DataForSEO 官方调用、成本控制、证据归一化、确定性评估、PostgreSQL Ready 库存、Temporal refill 和 high-water 停止链已接通。 |
| `TESTED` | Core 全门禁、FastAPI、Frontend typecheck/lint/build、桌面 E2E、Provider 关闭隔离和真实浏览器页面均通过。 |
| `REAL_PROVIDER_VERIFIED` | `YES`。真实 DataForSEO 请求成功，真实域名和 DataForSEO/SafeFetch 证据已写入当前 ElephTV Website Project。 |
| `BLOCKED` | `NONE`，LOCAL-REAL-002 范围内无剩余阻塞。 |
| `INPUT_REQUIRED` | `NONE`，LOCAL-REAL-002 所需项目输入、受保护 Secret Reference、Endpoint、预算和 Kill Switch 已配置。 |

本结论只覆盖 LOCAL-REAL-002，不代表 LOCAL-REAL-003 或后续阶段已经执行。

## 2. 权威边界

本轮遵守用户指定的 Production Baseline、共享仓库与 SEO-V4 补充协议、开发需求、整合实施需求、后端 Coding 计划、AI 分步手册、DataForSEO Cost Control V1.0、3A/3B 调查与 POC、仓库 Accepted ADR、Contract、Migration、自动化测试和当前 Coding State。

保持的运行架构：

```text
React SPA -> FastAPI Gateway -> private Fastify Backlinks Core -> Temporal
Temporal -> Backlinks Worker / Go Crawler
PostgreSQL -> business source of truth
```

没有新增第二套项目、鉴权、队列、Crawler、Browser Worker、CRM 或业务状态机。DataForSEO 只提供候选和 SEO 事实，不拥有 Recommendation、Opportunity、Contact、Email 或 Placement 状态。

## 3. 修复前失败证据与最小修复

### 3.1 Provider 配额首调用被误拒绝

修复前，Coordinator 会先创建当前 `provider_batch_requests` 行，Quota 查询随后把该行计入 paid-call count。`paidCallCount < maxPaidCalls` 导致 `maxPaidCalls=1` 时第一次调用被拒绝。

先增加失败测试，覆盖：

- 历史计数 `0`：允许。
- 当前请求已创建后的计数 `1`：仍允许。
- 计数 `2`：拒绝。

最小修复：

```text
paidCallCount <= maxPaidCalls
```

同时将失败记录 SQL 中的错误码参数显式转为 `text`，避免 `jsonb_build_object` 参数类型推断失败。

### 3.2 DataForSEO 空国家桶导致归一化失败

第一次真实 Provider 响应包含 `referring_links_countries[""]`。原 Mapper 把空键视为非法国家码并终止。

先增加失败测试：

```text
treats the provider empty country bucket as unknown
```

最小修复：

- 空国家桶归一化为 `unknown/null`。
- 其他任意非法国家键仍保持拒绝。
- 不用默认国家或虚构值替代 Provider 缺失事实。

### 3.3 High-water no-op Job 投影停留 queued

Temporal 在库存已达到 high-water 时正确返回 `inventory_sufficient`，但 PostgreSQL `backlink_jobs` 仍可能停留 `queued`。

先增加失败测试，要求生产 Runtime 持久化：

```text
status=success
step=inventory_sufficient
progress=100
```

最小修复后，真实 Job：

```text
id=4e010bed-957c-4956-9a42-cf44a954e5f0
status=success
step=inventory_sufficient
progress=100
result_summary={"reason":"inventory_sufficient","readyCount":20}
```

## 4. 真实项目输入

当前唯一 Website Project：

- Project key：`elephtv`
- Domain：`elephtv.com`
- Market/language：`ZA` / `en`
- Target URL：`https://elephtv.com/`
- Competitor discovery seed：`showmax.com`
- Products：ElephTV Android streaming app、live sports/channels、movies/TV series
- Keywords：live sports、streaming movies、TV series、live channels、African entertainment
- Recommendation context：`243b483b-2dc6-4251-a363-9c8809a4c950`
- Context snapshot：`1`
- Context status：`ACTIVE`

产品 API 未回退到 mock、fixture、seed、`.example.invalid` 或跨项目数据。

## 5. 真实 Provider 执行证据

### 5.1 成功请求

- Refill Job：`b837fa00-66e1-4faf-9987-81776f01a977`
- Provider Batch：`84840357-6ccf-4ec4-986a-4082539b194e`
- Provider endpoint：DataForSEO `backlinks/referring_domains/live`
- Batch status：`succeeded`
- Estimated cost：`27600` micros
- Actual cost：`27600` micros
- Temporal result：`completed`
- Evaluated：`60`
- Added：`20`
- Excluded：`7`
- Insufficient data：`7`
- 执行耗时：约 `42.31s`

成功请求产生的真实域名包括：

```text
dstv.com
currentaffairsza.com
dstvproinstallation.co.za
thesouthafrican.com
sapeople.com
```

公共 Gateway 最终返回 `20` 条 Recommendation；`20/20` 都带 DataForSEO `sourceReleaseId`，并包含 score、reason、observed/acquired time 和静态 SafeFetch 证据。检查结果：

```text
InvalidOrOwnDomainCount=0
DataForSeoEvidenceCount=20
```

### 5.2 失败调用的保守费用对账

第一次到达 Provider 的请求因空国家桶归一化失败，Provider 原始 envelope 在 Mapper 抛错后不可继续作为精确账单事实使用。本轮按当前官方账户价格上限保守结算：

- Provider Batch：`e6e0120d-814d-4a3a-8fec-b84cfb80fc20`
- Status：`failed`
- Failure：`DATAFORSEO_RESPONSE_NORMALIZATION_FAILED_RECONCILED_MAX_COST`
- Estimated：`100000` micros
- Reconciled actual：`27600` micros
- Ledger：`settled`

另一个 Batch `4ecf063e-97e2-4e11-9cfc-590f6aa2e501` 在 Provider 网络调用前被旧 Quota 逻辑拒绝，没有实际费用和 Ledger。

### 5.3 最终预算

```text
limit_micros=100000
spent_micros=55200
reserved_micros=0
remaining_micros=44800
budget_version=5
```

没有 unknown charge、悬挂 reservation 或未结算 Ledger。

## 6. 持续推荐池行为

### 6.1 High-water 停止

库存达到 high-water 后，真实 refill Job 直接完成为 `inventory_sufficient`。执行前后：

```text
provider_batch_rows=3 -> 3
provider_request_count=3 -> 3
```

因此 high-water 检查没有触发新的付费调用。

### 6.2 刷新只读 PostgreSQL 库存

公共读取：

```text
GET /api/v1/projects/elephtv/backlinks/recommendations
```

返回 HTTP `200` 和 PostgreSQL 中的真实推荐。页面刷新不等待 DataForSEO，也没有增加 Provider Request。

### 6.3 Provider 关闭隔离

本轮真实重启为：

```text
DATAFORSEO_ENABLED=false
BACKLINKS_WORKER_ENABLED=true
```

关闭期间验证：

- 本地产品状态：`ok`
- 公共 Recommendation API：HTTP `200`，返回 `20` 条
- Project API：HTTP `200`
- Gmail connection status API：HTTP `200`
- Provider Batch：`3 -> 3`
- Budget spent：保持 `55200` micros

验证完成后已恢复：

```text
backlinks-api.env: DATAFORSEO_ENABLED=true
backlinks-worker.env: DATAFORSEO_ENABLED=true
backlinks-worker.env: BACKLINKS_WORKER_ENABLED=true
```

API 进程中的 `BACKLINKS_WORKER_ENABLED=false` 是既有进程隔离：独立 Worker 进程承担 Temporal activities，API 进程不重复启动 Worker。

## 7. 自动化验证

### 7.1 Backlinks Core 全门禁

`npm run verify:backlinks`：PASS

| Gate | 结果 |
| --- | --- |
| TypeScript typecheck | PASS |
| ESLint | PASS |
| Source manifest | `28` entries valid |
| Dependency allowlist | PASS |
| License check | `693` packages valid |
| OpenAPI | `49` paths valid |
| Migration check | `30` migrations，head `0037` |
| Unit | `84` files，`469` tests passed |
| API | `30` files，`99` tests passed |
| Contract | `26` files，`168` tests passed |
| Integration | `49` files passed，`4` skipped；`182` tests passed，`13` skipped |
| Security | `9` files，`102` tests passed |
| Resilience | `3` files，`8` tests passed |

Integration skip 是既有环境门控，不是测试失败。

### 7.2 FastAPI Gateway

- Pytest：`66 passed, 1 skipped`
- Ruff：PASS
- `/health`：HTTP `200`
- `/ready`：HTTP `200`
- `/api/v1/projects`：HTTP `200`

### 7.3 Frontend

- TypeScript typecheck：PASS
- ESLint：PASS
- Production build：PASS
- Desktop Playwright E2E：`2 passed`

### 7.4 真实浏览器

使用系统 Chrome 打开：

```text
http://localhost:5173/projects/elephtv/backlinks/recommendations
```

验证：

- 页面 HTTP `200`
- Browser page/request error：`0`
- ElephTV 推荐池成功渲染
- 页面当前显示 `18` 条 Ready 推荐
- 页面显示真实域名、评分、主题质量、风险判断、数据状态和人工创建 Opportunity 操作

截图：

```text
frontend/output/playwright/local-real-002-live.png
```

`127.0.0.1:5173` 不是本地产品公布入口；使用它会与配置中的 `localhost:7200` 形成不同 origin。本轮按状态脚本公布的 `http://localhost:5173` 完成真实页面验证。

## 8. 最终本地运行状态

最终状态脚本：

```text
status=ok
runtimeMode=LOCAL_PRODUCT
runId=20260804-170624
projectKey=elephtv
```

| 组件 | 地址 | 状态 |
| --- | --- | --- |
| React SPA | `localhost:5173` | HTTP `200` |
| FastAPI Gateway | `127.0.0.1:7200` | HTTP `200` |
| Private Fastify Core | `127.0.0.1:7301` | HTTP `200` |
| PostgreSQL | `127.0.0.1:55432` | healthy |
| Temporal | `127.0.0.1:57233` | healthy |
| Temporal metrics | `127.0.0.1:59090` | listening |

PostgreSQL：

- Required major：`18`
- Alembic head：`20260724_0007`
- Backlinks migration head：`0037`

Temporal：

- Namespace：`growthos-backlinks-canary`
- Namespace ready：`true`
- Backlinks Worker：running

## 9. LOCAL-REAL-002 PASS 条件

| PASS 条件 | 结果 |
| --- | --- |
| 小预算真实 Provider 调用产生非 demo domain，并带 source/cost/acquiredAt/score/reason | `REAL_PROVIDER_VERIFIED` |
| 5 分钟内至少 10 条可评估推荐，联系人异步 | `PASS`，约 42.31 秒写入 20 条；联系人不阻塞推荐入池 |
| 消耗到 low watermark 自动补充，达到 high watermark 停止 | `PASS`，high-water Job 持久化为 `inventory_sufficient` |
| Refresh/change batch 只读取或 claim PostgreSQL Ready，不同步等待 Provider | `PASS`，读取与 high-water 验证均未增加 Provider Request |
| DataForSEO 关闭时库存仍可见，其他流程不被阻塞 | `PASS`，20 条仍可读，Project/Gmail API 正常 |

阶段总结果：

```text
IMPLEMENTED
TESTED
REAL_PROVIDER_VERIFIED=YES
BLOCKED=NONE
INPUT_REQUIRED=NONE
```

## 10. Secret 与操作约束

- DataForSEO 凭据只通过受保护 Secret Reference 解析。
- 未在仓库、PostgreSQL 业务字段、日志或本文档写入原始 login/password/API key。
- Secret 扫描命中均为测试 fixture 或字段名，没有发现本轮真实凭据。
- 未执行 Git commit。
- 未执行 Git push。
- 未撤销或覆盖用户已有改动。
- 未执行公网发布。
- 未启动 LOCAL-REAL-003。
