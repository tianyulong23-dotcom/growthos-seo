# LOCAL-PRODUCT-011 Opportunity 最新优先与移出当前列表

- 执行日期：`2026-08-05`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-011`
- 状态：`PASS`
- 最终本地运行 ID：`20260805-124812`
- Website Project：`elephtv`

## 1. 结论

Opportunity 已改为由 PostgreSQL 按 `joinSequence DESC, id DESC` 返回最新记录，稳定 cursor
只向更旧记录翻页。前端不再本地排序、拼接或过滤一页数据；从 Recommendation 加入后，使用
Core 创建响应和公开 Gateway 首次列表响应确认新记录位于第一行。

默认列表现在是“当前工作”，包含 `ACTIVE` 和 `PAUSED`，排除 `ARCHIVED`。用户可从列表或详情
使用同一命令暂停、移出当前列表和恢复。移出只写
`managementStatus=ARCHIVED`，没有新增或调用硬 DELETE API，不改变 Opportunity 的推进阶段、
结果、履约、联系人、Email、Placement 或历史事件。

创建、归档和恢复都经过 Frontend generated client -> FastAPI Gateway -> private Core ->
PostgreSQL。成功 UI 只在 Core 命令提交并由 Gateway 重新读取到新版本后更新；unknown outcome
会复用同一个 idempotency key 重试并读取权威详情，不会重复执行命令或在浏览器伪造成功。

## 2. 实现范围

### Core、PostgreSQL 与公开契约

- Opportunity list 使用 `join_sequence DESC, id DESC`。
- cursor 使用 `< joinSequence` 或同序列下 `< id` 查询更旧记录，避免并发新加入造成重复或遗漏。
- 未传 `managementStatus` 时查询 `management_status <> 'ARCHIVED'`。
- 显式 `ARCHIVED` 只查询归档记录。
- 搜索、business stage、outcome、fulfillment 和 cursor 均在服务端执行。
- list 返回联系人候选、辅助邮箱、联系人复核标志和真实下游事实标志。
- 创建响应返回服务端权威的 `opportunityId`、`joinSequence`、`websiteProjectId`、
  `targetSiteKey`、`targetHostAscii` 和 `version`。
- FastAPI Gateway 与两份 OpenAPI、Frontend generated client 已同步，没有丢字段或重命名。

### Frontend

- 默认筛选改为“当前工作”，另提供“已归档”。
- 列表第一列以规范化网站 domain 为主信息，邮箱仅作为辅助信息。
- 每行更多操作菜单支持暂停和移出当前列表；详情使用同一命令与文案。
- 无 Draft/Send/Reply/Placement 时显示“撤销加入”；存在下游事实时显示“归档”。
- 确认框说明操作后果，原因不再是必填；可选备注附加在标准审计 reason 后。
- 命令携带当前 `expectedVersion` 和一次生成的 UUID idempotency key。
- 409、403、失败和未知结果不会本地删除或改状态，而是重新读取服务端权威数据。
- Recommendation 创建成功后定向刷新 Recommendation 和 Opportunity query，不要求整页刷新。

## 3. 真实浏览器验收

### 3.1 从真实 Recommendation 加入

使用已有真实 Recommendation 和已发现联系人：

| 项目 | 实测结果 |
| --- | --- |
| Recommendation | `4a3849d5-95a8-4901-8dfb-ff8a2d453c61` |
| Contact Candidate | `adf16bb6-b3b4-4fd9-b5f1-906cc21c243d` |
| Domain / Email | `sapeople.com` / `info@sapeople.com` |
| 新 Opportunity | `53216aa0-4be9-45f5-872b-a43e4411cb74` |
| Website Project ID | `e0bfde33-54bd-454a-ab61-cf7a4a48dcf0` |
| joinSequence | `7` |
| 创建版本 | `1` |
| 创建 HTTP | `POST /api/v1/projects/elephtv/backlinks/opportunities` |
| Gateway 响应 | `201`，`177ms` |
| 浏览器点击到 Opportunity 页面 | `3.265s` |
| 首次列表结果 | 新 Opportunity 位于第一行 |
| 整页刷新 | 不需要 |

创建请求体使用 Recommendation `expectedVersion=1`；创建响应同时返回 Project、Opportunity、
规范化 domain、joinSequence、联系人和版本。随后 Gateway 当前工作列表首次响应的第一项就是
该 Opportunity，未使用 optimistic prepend。

### 3.2 移出当前列表并查看归档

该 Opportunity 没有下游事实，因此列表和详情显示“撤销加入”。确认框明确说明只归档并移出
当前工作列表，不删除 Recommendation 或 Opportunity 历史。

| 项目 | 实测结果 |
| --- | --- |
| 请求 | `PATCH .../opportunities/{id}/management` |
| 请求体 | `expectedVersion=1`, `managementStatus=ARCHIVED` |
| 标准 reason | `Opportunity join removed from current work.` |
| idempotency key | `11649e3d-8f69-4658-bc29-1fbe378b4397` |
| Gateway 响应 | `200`，`368ms` |
| 确认到权威列表更新 | `4.237s` |
| 新版本 | `2` |
| 当前工作列表 | 该行消失 |
| 已归档列表 | 仅返回该归档记录 |
| 详情 | domain、邮箱、阶段、结果、履约和联系人事实仍存在 |

归档状态下仍为 `JOINED | ARCHIVED | OPEN | NOT_EXPECTED`，联系人仍为
`info@sapeople.com`，`hasDownstreamFacts=false`。浏览器 Network 中没有 Opportunity DELETE。

### 3.3 恢复到当前工作

| 项目 | 实测结果 |
| --- | --- |
| 请求体 | `expectedVersion=2`, `managementStatus=ACTIVE` |
| 标准 reason | `Opportunity restored to active work.` |
| idempotency key | `5d3397bf-159e-4be4-b69e-7e77e40a8226` |
| Gateway 响应 | `200`，`356ms` |
| 确认到权威列表更新 | `3.436s` |
| 新版本 | `3` |
| 已归档列表 | 该记录消失 |
| 当前工作列表 | 该记录恢复并位于第一行 |

最终 Gateway 当前工作响应返回 `7` 条，第一项为 `sapeople.com`，其
`project/opportunity/version/joinSequence` 分别为
`e0bfde33-54bd-454a-ab61-cf7a4a48dcf0`、
`53216aa0-4be9-45f5-872b-a43e4411cb74`、`3`、`7`。

## 4. PostgreSQL 权威与历史

最终 Opportunity 行：

`JOINED | ACTIVE | OPEN | NOT_EXPECTED | version=3 | joinSequence=7`

联系人候选仍为 `info@sapeople.com`，置信度 `90`，状态 `promoted`，未要求人工复核。
Recommendation 在用户确认加入时按既有规则变为 `accepted, version=2`；后续归档和恢复后仍为
同一状态与版本，没有被管理命令改写。

生命周期与审计链：

| sequence/version | 事件 | 状态变化 |
| --- | --- | --- |
| `1/1` | `opportunity.created` | 创建为 `ACTIVE` |
| `2/2` | `opportunity.management_status.changed` | `ACTIVE -> ARCHIVED` |
| `3/3` | `opportunity.management_status.changed` | `ARCHIVED -> ACTIVE` |

三个 idempotency record 分别为 `opportunity.create`、两次
`opportunity.management.patch`，响应状态为 `201/200/200`。生命周期、审计和幂等记录中的
Opportunity ID、Project ID、版本和 reason 与 Gateway 响应一致。

项目 Opportunity 数量由 `6` 增至 `7`，最大 joinSequence 由 `6` 增至 `7`；最终为
`ACTIVE=7, PAUSED=0, ARCHIVED=0`。未清空或重建数据库。

## 5. 外部调用与边界

| 计数 | 验收前 | 验收后 | 本任务新增 |
| --- | ---: | ---: | ---: |
| AI Model Run | `4` | `4` | `0` |
| DataForSEO batch request | `3` | `3` | `0` |
| DataForSEO provider request | `3` | `3` | `0` |
| Gmail SendIntent | `0` | `0` | `0` |
| Gmail SendAttempt | `0` | `0` | `0` |

本任务没有调用 AI、Gmail、DataForSEO 或产品 Browser Worker。当前运行的 Browser Worker
stdout/stderr 均为 `0` 字节；Playwright 仅用于操作公开本地产品页面进行验收。

除用户确认加入时按既有规则接受 Recommendation 外，归档和恢复没有修改 Recommendation、
Email、Placement 或 Task 状态。没有自动发送邮件，没有重新执行 `LOCAL-REAL-000..009` 或
`LOCAL-PRODUCT-010`。

## 6. 测试结果

| 验证 | 结果 |
| --- | --- |
| Core Opportunity Query/Command/API 定向测试 | `4 files / 4 tests passed` |
| PostgreSQL 排序、cursor、归档、搜索和项目隔离 integration | passed |
| FastAPI Gateway 定向测试 | `19 passed` |
| Frontend Opportunity/Recommendation source tests | `5/5 passed` |
| 定向 Playwright | desktop + mobile，`2/2 passed` |
| Core typecheck / lint / build | passed |
| Frontend typecheck / lint / production build | passed |
| Backlinks OpenAPI | `57 paths` |
| Shared contracts | `79 public paths / 85 operations` |
| Frontend generated Backlinks client | `58 operations` |
| `git diff --check` | 无 whitespace error；仅 Windows LF/CRLF 提示 |

Frontend production build 只有既有的单 chunk 大于 `500 kB` 警告。定向真实浏览器控制台没有
应用 API 错误；仅两个外部站点 favicon 分别出现证书域名错误和 `404`。

探索期间运行整个 `private-server.test.ts` 时发现其既有 operation count 断言仍期望 `58`，
而当前 private server 为 `59`。`LOCAL-PRODUCT-011` 没有新增 operation，本任务要求的
OpenAPI、shared contract、generated client、Opportunity API 和 Gateway 定向 Gate 均已通过；
按照严格范围未改写该非 011 断言。

## 7. 运行与证据

最终健康检查：

- Frontend `http://localhost:5173`：`200`
- FastAPI Gateway `http://localhost:7200`：`200`
- private Core `http://127.0.0.1:7301`：`200`
- Browser Worker `http://127.0.0.1:7401`：`200`
- PostgreSQL 18：healthy，Backlinks head `0040`
- Temporal：healthy，namespace ready

浏览器证据：

- `output/playwright/local-product-011-restored-current.png`
- `output/playwright/local-product-011-page-2026-08-05T04-51-45-213Z.yml`
- `output/playwright/local-product-011-page-2026-08-05T04-54-18-864Z.yml`
- `output/playwright/local-product-011-page-2026-08-05T04-54-48-537Z.yml`
- `output/playwright/local-product-011-page-2026-08-05T04-56-36-013Z.yml`

## 8. 最终状态

`PASS`

`LOCAL-PRODUCT-011` 的最新优先、稳定 cursor、当前工作语义、列表直接归档、归档详情、恢复、
generated contract、Gateway/Core/PostgreSQL 权威贯通均已实现并通过定向测试与真实浏览器验收。

未执行 `LOCAL-PRODUCT-012` 或 `LOCAL-PRODUCT-013`，未执行 Git commit/push。完成后停止，
等待用户确认。
