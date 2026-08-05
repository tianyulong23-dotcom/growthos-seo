# LOCAL-REAL-003 公开联系人发现

- 执行日期：`2026-08-04`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-REAL-003`
- 状态：`PASS_LOCAL_FUNCTION`
- 当前 Website Project：`elephtv`
- 最终运行 ID：`20260804-184031`
- 本地产品入口：`http://localhost:5173`

## 1. 结论

当前真实 ElephTV Website Project 已完成公开联系人发现的本地业务闭环：

```text
Recommendation -> EnrichmentJob -> PageDiscovery -> SafeFetch -> Cheerio
-> optional shared Browser Worker -> ContactCandidate -> ContactEvidence
```

Recommendation Ready 后会幂等创建联系人发现 Job；现有 Temporal Worker 自动消费
`pending/retry_scheduled` Job。公共 Gateway 已支持启动、重试、状态查询、候选与证据读取、
人工补充、人工修正和确认。

本轮没有新增第二套 Worker、Queue、Crawler 或业务状态机。PostgreSQL 仍是业务事实源，
Temporal 仍负责持久任务，Browser Provider 复用仓库已有 Browser Worker/Playwright Adapter。

## 2. 本轮实现

### 2.1 数据与运行链

- 新增 migration `0038_backlink_contact_enrichment.sql`，保存有界 Job 和逐页执行事实。
- Job 默认限制为 `maxPages=8`、`maxDepth=2`、`maxAttempts=3`，均为可配置上限。
- PageDiscovery 覆盖首页、常见路径、导航/页脚、站内链接及安全取得的 robots/sitemap。
- 静态主路径使用 SafeFetch/Undici；保留 SSRF、DNS、私网地址、端口、重定向、体积和超时保护。
- Cheerio 提取 `mailto`、独立文本节点中的可见邮箱、受限文本混淆和 JSON-LD。
- 邮箱语法使用 validator，域名使用 tldts 校验有效公共后缀；不执行 SMTP 探测。
- 静态结果不足并存在动态页面证据时，调用共享 Browser Worker；系统 Chrome 可作为
  Playwright bundled Chromium 缺失时的回退。
- 页面超时或部分失败落为 `partially_completed`、`no_contact_found` 或
  `retry_scheduled`，不阻塞推荐池。

### 2.2 契约与产品接线

- 接通 Core route、production runtime、Temporal Activity/Workflow/Registry/Worker 和 outbox relay。
- 接通 FastAPI Gateway、共享 OpenAPI、event registry、Temporal registry 和 generated client。
- 前端 Recommendation 行支持“发现联系人”、状态轮询和失败重试，不回退 mock/fixture。
- Contact Evidence 返回并持久化：
  `sourceUrl`、`observedAt`、`method`、`snippet`、`confidence`、
  `ruleVersion`、`contentHash`、`domainRelation`。

### 2.3 本地 Browser 开关

启动命令：

```powershell
.\Start-GrowthOS-LocalProduct.ps1 -EnableDataForSeo -EnableBrowser -SkipBuild
```

当前项目数据库 Kill Switch：

```text
capability=backlinks.browser.v1
blocked=false
reason=LOCAL_PRODUCT explicit EnableBrowser startup
version=1
```

不需要 canary allowlist、approvedBy、authorization window、Cloudflare、gcloud 或公网域名。

## 3. 真实运行结果

以下记录均来自当前 `elephtv` 项目的真实 Recommendation 库存和公共 API。邮箱在结果文档中脱敏，
数据库和产品 API 保留完整业务值。

| Domain | Job ID | 状态 | 页数 | 邮箱数 | 证据数 | Browser | 可用邮箱 | Evidence URL |
| --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
| `weekendspecial.co.za` | `27a63fa9-d41a-4223-8540-46184a02b5e1` | `completed` | 8 | 4 | 7 | no | `ed***@weekendspecial.co.za` | `https://weekendspecial.co.za/about-us/` |
| `stuff.co.za` | `52456a27-5eb4-45c0-be61-72d883047233` | `completed` | 8 | 2 | 22 | no | `st***@stuff.co.za` | `https://stuff.co.za/category/news/app-news/` |
| `themediaonline.co.za` | `e497784a-bd12-471c-9dbb-ebb2f3161fe4` | `completed` | 8 | 2 | 16 | no | `ne***@themediaonline.co.za` | `https://themediaonline.co.za/category/awards-2/` |
| `sapeople.com` | `bee4ac68-ec07-4c73-a597-35605690d3e9` | `partially_completed` | 8 | 7 | 24 | yes | `in***@sapeople.com` | `https://www.sapeople.com/contact-sa-people/` |

`sapeople.com` 的部分页面返回 `HTTP_404`，但共享浏览器回退成功执行，并保存了公开联系人和
证据。因此状态正确为 `partially_completed`，不是产品阻塞。

抽样证据字段：

```text
method=mailto | visible_text
confidence=80 | 90
ruleVersion=contact-purpose-rules.v1
domainRelation=same_registrable_domain
contentHash=64-character sha256
```

公共 Gateway 验证：

```text
POST /api/v1/projects/elephtv/backlinks/contact-enrichment-jobs/{jobId}/retry
-> HTTP 202

GET /api/v1/projects/elephtv/backlinks/contact-enrichment-jobs/{jobId}
-> HTTP 200

GET /api/v1/projects/elephtv/backlinks/contacts/candidates?prospectId={prospectId}
-> HTTP 200
```

当前项目至少已有以下可供 `LOCAL-REAL-004` 使用的公开邮箱：

```text
ed***@weekendspecial.co.za
st***@stuff.co.za
ne***@themediaonline.co.za
in***@sapeople.com
```

## 4. 真实页面发现的缺陷与修复

### 4.1 PostgreSQL 18 outbox 参数推断

第一次真实 Job 写 outbox 时，PostgreSQL 18 报告同一参数在 UUID 与文本上下文中的类型推断冲突。
已在 outbox SQL 中显式转换 UUID/text 参数，并增加回归测试。修复后 Job 事件由 relay 正常发布，
Worker 自动执行。

### 4.2 相邻 DOM 文本误拼接

真实页面暴露出整页 `.text()` 会把相邻节点拼接成伪邮箱，例如把邮箱和下一段文字合并。
已改为逐文本节点扫描，避免跨 DOM 节点组合候选。

### 4.3 自然语言误判为混淆邮箱

原混淆规则可能把自然语言中的 `at` 和普通句点组合成邮箱。修复后：

- `[at]` / `(at)` 形式继续支持；
- 单词 `at` 必须配合 `[dot]` / `(dot)` / `dot`；
- tldts 必须识别有效 ICANN/private suffix。

已将真实运行中确认的 `11` 条误候选标记为 `invalid`，并失效其 `15` 条关联证据，没有删除或覆盖
真实候选。当前项目保留 `37` 条 active candidate、`130` 条 active evidence。

## 5. 改动相关测试

按 V1.1 规则，本轮只执行改动相关测试和一次真实运行验证，没有运行 100 站 Gold Set，也没有执行
全仓库综合 Gate。

| 范围 | 结果 |
| --- | --- |
| Core 主相关测试 | `11` files，`73` tests passed |
| Core 补充相关测试 | `3` files，`7` tests passed |
| Parser + private server 回归 | `17` tests passed |
| Gateway / Contract / Database | `26` tests passed |
| Frontend source tests | PASS |
| Frontend TypeScript | PASS |
| Browser Worker typecheck/build | PASS |
| Core typecheck/build | PASS |
| OpenAPI | `54` paths valid |
| Database migrations | `31` files，head `0038` |

## 6. 最终本地运行状态

`Status-GrowthOS-LocalProduct.ps1`：

```text
status=ok
runtimeMode=LOCAL_PRODUCT
runId=20260804-184031
projectKey=elephtv
```

| 组件 | 地址 | 状态 |
| --- | --- | --- |
| React SPA | `http://localhost:5173` | HTTP `200` |
| FastAPI Gateway | `http://localhost:7200` | HTTP `200` |
| Private Fastify Core | `http://127.0.0.1:7301` | HTTP `200` |
| Shared Browser Worker | `http://127.0.0.1:7401` | HTTP `200` |
| PostgreSQL 18 | `127.0.0.1:55432` | healthy，migration `0038` |
| Temporal | `127.0.0.1:57233` | healthy，namespace ready |

## 7. 最终状态

```text
PASS_LOCAL_FUNCTION
```

- 已完成至少 3 个真实域名的抓取、状态、候选和证据闭环。
- 已验证共享 Browser Worker 的真实动态页面回退。
- 当前项目已有多个可供下一阶段使用的公开邮箱。
- `INPUT_REQUIRED=NONE`。
- 未执行 Git commit/push。
- 未撤销用户已有改动。
- 未执行公网发布。
