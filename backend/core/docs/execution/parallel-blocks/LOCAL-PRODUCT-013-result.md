# LOCAL-PRODUCT-013 009 后产品使用 Gate

- 执行日期：`2026-08-05`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-013`
- 最终状态：`PASS_LOCAL_PRODUCT_UX`
- 最终本地运行 ID：`20260805-195915`
- Organization：`11111111-1111-4111-8111-111111111111`
- Workspace：`cec65d3f-92e5-4b13-aa26-7b39e74e213a`

## 1. 结论

`LOCAL-PRODUCT-010..012` 已通过同一套真实本地产品链集中验收。ElephTV 和 AWOL Vision 均由
Website Project 权威上下文驱动；AWOL 不再读取 ElephTV 推荐库存，而是使用自己的 domain、国家、
语言、产品、关键词和目标 URL，通过同一个 DataForSEO/Temporal/Core 链生成并持久化了 `21` 条推荐。

Opportunity 的最新优先、加入、归档、恢复和历史版本已从 UI 贯通到 PostgreSQL；现有成功 Draft Job
可在刷新、重开 URL 和进程重启后恢复同一个 Job/Draft，Model Run 数量不增加。Gmail、Mail 和 Links
均按 Website Project 隔离；本 Gate 未自动批准草稿、未自动发送邮件、未修改 Opportunity 业务阶段，
也未建立第二套 Provider、队列、监控或业务权威。

最终状态不是 `PASS_WITH_EXTERNAL_ACTION`：第二个真实项目 AWOL Vision 已具备完整资料并已经生成真实
推荐库存。AWOL Gmail 仍保持未连接，这是用户控制的正常项目级授权状态，不是本次代码阻塞。

## 2. 运行时与公开请求链

使用正式脚本在不清空 PostgreSQL 或 Temporal 的前提下重启：

```powershell
.\Restart-GrowthOS-LocalProduct.ps1 `
  -EnableDataForSeo:$false `
  -EnableAi:$false `
  -EnableGmailSend:$false `
  -EnableGmailSync:$false `
  -EnableBrowser:$false
```

最终监听和健康状态：

| 组件 | 地址 / 端口 | 进程 / 容器事实 | 结果 |
| --- | --- | --- | --- |
| Frontend | `http://localhost:5173` | PID `44952` | 可访问 |
| FastAPI Gateway | `http://localhost:7200` | PID `46452` | `/health` 200，`/ready` 200 |
| Private Core | `http://localhost:7301` | PID `17352` | `/health` 200，仅服务端访问 |
| PostgreSQL 18.4 | `localhost:55432` | Docker PID `25220` | healthy，Alembic `20260805_0008`，Backlinks `0042` |
| Temporal | `localhost:57233` | Docker PID `25220` | healthy，namespace `growthos-backlinks-canary` ready |

真实浏览器网络来源只出现 `localhost:5173` 和公开 Gateway `localhost:7200`，没有直连 `7301`、
PostgreSQL 或 Temporal。快速项目切换期间取消旧请求产生的 `ClientDisconnect` 只存在于 Gateway 日志，
没有导致页面错误或旧项目响应覆盖当前项目。

## 3. Website Project 与真实推荐池

### 3.1 AWOL 项目上下文

| 字段 | 事实 |
| --- | --- |
| Website Project ID | `4ec81dca-a0d0-40f3-9ff1-9cdff6613924` |
| Project Key | `awolvision-com-4ec81dca` |
| 名称 / Domain | `AWOL Vision` / `awolvision.com` |
| 国家 / 语言 | `US` / `en` |
| Products | `Home cinema projector` |
| Keywords | `home cinema` |
| Target URL | `https://awolvision.com/` |
| Context Version | `4` |
| Profile ID | `06420fcb-7dfc-4e53-9928-17a434d13ad4` |

项目选择器显示全部两个 active 项目。ElephTV 与 AWOL 往返切换、浏览器前进/后退和刷新后，URL、
页面标题、项目选择器和响应 `websiteProjectId` 均保持一致。

### 3.2 DataForSEO 最终真实执行

- 业务 Job：`dcb1aa30-d88f-473c-bb51-261e5f083c3c`
- Temporal Workflow：
  `backlinks:cec65d3f-92e5-4b13-aa26-7b39e74e213a:4ec81dca-a0d0-40f3-9ff1-9cdff6613924:recommendation-refill:v1:dcb1aa30-d88f-473c-bb51-261e5f083c3c`
- 结果：`success / ready_inventory_stored / progress 100`
- 实际工作流耗时：`44.772s`
- PostgreSQL 记录耗时：`44.284s`
- 结果统计：`added 21 / evaluated 84 / ready 21 / excluded 5 / insufficient 14`
- 真实 Provider Ledger：`1`
- DataForSEO 付费调用：`1`
- 记录成本：`27,600 micros`
- AI 调用：`0`

此前同一 Job 的两次尝试分别在 Provider 前被 kill switch 和错误配额判定阻断，均无 provider task ID、
无成本、无 Ledger、无付费调用。诊断阶段对公开 Job API 做了 `180` 次轮询，持续约 `367.7s`，由此定位
“当前请求刚创建的 running batch 被错误计入历史配额”的死锁。修复后仍恢复同一个业务 Job 和 Temporal
Workflow，没有创建第二个业务 Job；受限恢复最多允许两次且只适用于明确的 Provider 前零成本失败。

最终公开推荐 API 返回 `21` 条 AWOL 项目库存，包括 `valerion.com`、`homecinemasdubai.com`、
`awolvision.uk`、`awolvision.jp`、`awolvisionpro.com`、`wall-ebuilders.com`、`lasertv.com` 和
`themiddle.co` 等。推荐事实来自 DataForSEO 和安全静态抓取证据，不使用 ElephTV seed、缓存或回退。

## 4. Opportunity 纵向验收

从 AWOL 的真实 Recommendation `amchimovie.com`
（Recommendation `9a0f9ae8-744a-4ec9-810a-bd65eb405d42`，已确认联系人
`admin@amchimovie.com`）执行加入：

| 验收项 | 结果 |
| --- | --- |
| Opportunity ID | `ca18908a-78c3-4b09-851b-474c842924a5` |
| 加入后第一次列表 | 第一行 |
| 归档原因 | `LOCAL-PRODUCT-013 真实归档恢复验收` |
| 归档列表 | 可找到 |
| 恢复原因 | `LOCAL-PRODUCT-013 真实恢复验收` |
| 刷新 / 重启后 | `ACTIVE`、version `3`、joinSequence `9`，仍为第一行 |
| 生命周期 | v1 created、v2 archived、v3 restored |
| 审计 | 三次操作均为 success |

归档和恢复只修改管理状态，不改变 Opportunity 业务阶段，也未删除 Draft、Send、Reply、Placement、
Observation 或审计事实。

## 5. Draft 持续轮询与恢复

本 Gate 对现有成功任务执行零 AI 调用恢复验证：

| 字段 | 事实 |
| --- | --- |
| Opportunity | `6c2d65ea-c9f6-4d0c-bb26-ef2204274d0d` |
| Contact | `45517210-0eaa-4412-94f8-6cb9f51c3dc8` |
| Logical Key | `initial-outreach:6c2d65ea-c9f6-4d0c-bb26-ef2204274d0d:45517210-0eaa-4412-94f8-6cb9f51c3dc8` |
| Draft Job | `3f15ffea-6b77-4e4e-988f-7f3351590253` |
| Draft | `aaeae74d-b9e8-4452-8535-10b7bf3b94e1` |
| Draft Version | `828531a3-25e6-4d40-b9de-28ff39d0ec85` |
| 最终状态 | `SUCCEEDED` |
| 排队 / 开始 / 完成 | `04:10:39.750Z` / `04:10:40.064Z` / `04:10:49.326Z` |
| Queue / Generation / Persistence | `314ms` / `9204ms` / `12ms` |

重新打开 `/drafts/new?opportunityId=...` 在刷新前后和本地进程重启后都重定向到同一个 Draft。页面加载
真实主题 `Potential ElephTV collaboration`、`MODEL` 来源和正文。数据库 Model Run 总数在重启前后
均为 `7`，本轮增量为 `0`；没有重复创建 Draft Job，也没有重复调用 AI。

013 对已有成功 Job 走直接恢复路径，因此没有制造新的 RUNNING 任务来重复计费；010 已证明的持续轮询
状态字段、真实阶段、已耗时、最后查询时间和成功后跳转继续由同一 generated contract 路径读取。

## 6. Gmail、Mail 与 Links

Gmail 项目隔离：

| 项目 | Connection | 状态 |
| --- | --- | --- |
| ElephTV | `ce7b81a9-9023-4a0b-a1ba-371dca9fc737` / `tianyulong23@gmail.com` | `CONNECTED / AVAILABLE` |
| AWOL Vision | `null` | 页面显示 `连接 Gmail` |

即使使用相同 Gmail 账号，AWOL 也必须单独显式 OAuth 授权并建立独立项目绑定。本 Gate 只打开 Gmail
Connection、发送审核和 Mail Center，未批准草稿、未创建 SendIntent、未发送邮件、未启动 Gmail sync，
也未伪造回复。

ElephTV Links 仍返回两行：一个已确认 Placement 和一个 Candidate。已确认 Placement
`6fdfa083-1f8e-57d0-bbb8-3498e0bb32c9` 从 `https://elephtv.africa/` 指向
`https://elephtv.com/become-an-elephtv-reseller/`，状态 `VALID / active`，监控开启，version `3`。
最新 Observation 为 `9b7e863c-e63a-47c0-a340-5923c968c74a`，Monitor Run 为
`1f730bd4-63ab-41c7-8883-4eb7cf1312cd`，PostgreSQL 共保留 `3` 条 Observation。AWOL Links 为 `0`；
Opportunity 的归档/恢复没有删除或改写这些 Links 事实。

## 7. 纵向证据表

| 用户操作 | FastAPI / generated operation | Core command/query | PostgreSQL 权威事实 | Temporal | 刷新 / 重启读取 |
| --- | --- | --- | --- | --- | --- |
| 选择、维护项目 | `platformListWebsiteProjectsV1`、`platformGetWebsiteProjectV1`、`platformUpdateWebsiteProjectV1` | Platform Project authority 和 Project Context Projection | WebsiteProject、Profile、PromotionTarget、Context Snapshot、Audit、Outbox | Context projection 通过既有 durable 链发布 | 两个 active 项目和 AWOL context v4 保持 |
| AWOL 推荐补货、查看推荐 | `backlinksRequestRecommendationRefillV1`、`backlinksListRecommendationsV1` | RecommendationRefill reservation/workflow、RecommendationsQuery | 同一 Job、Provider Request/Ledger、21 条 ready Recommendation | 同一 workflow ID 成功恢复并完成 | 重启后仍为 21 条，首条 `valerion.com` |
| Recommendation 加入 Opportunity | `backlinksCreateOpportunityV1`、`backlinksListOpportunitiesV1` | OpportunitiesCommand、OpportunitiesQuery | Opportunity、joinSequence、lifecycle、audit | 不需要新业务 workflow | 重启后 ACTIVE v3 且第一行 |
| 归档和恢复 Opportunity | `backlinksPatchOpportunityManagementV1` | Opportunity management command/query | management state、version、history、audit | 不需要新业务 workflow | 归档筛选可见，恢复后状态持续 |
| 打开/恢复 Draft | `backlinksGetLatestDraftJobV1`、`backlinksGetDraftJobV1`、`backlinksGetDraftV1` | DraftQuery 和既有 Draft workflow | 同一 Job、Draft、Version、Model Run | 读取同一已完成 workflow | 相同 Draft ID，Model Run 不增加 |
| 打开 Gmail、发送审核、Mail Center | `backlinksGetGmailConnectionStatusV1`、`backlinksGetSendIntentV1`、Reply/Mail queries | Gmail connection、SendIntent、Mail/Reply queries | Eleph connection 绑定 Eleph；AWOL 无连接；无新增 Send | 未启动 send/sync workflow | 重启后绑定和空状态保持 |
| 打开 Links | `backlinksListLinksV1`、`backlinksGetPlacementLinkV1`、`backlinksGetPlacementEvidenceV1` | PlacementLinksQuery、Monitoring repository | Placement、Observation、Monitor Run | 复用既有监控 workflow | Eleph 2 行和 3 条 Observation 保持，AWOL 0 |

每一行均从公开 Frontend/FastAPI 读取，不依赖页面内存、静态数组、mock fallback 或测试拦截。

## 8. 项目切换、刷新与重启

真实浏览器依次执行 ElephTV Opportunity -> AWOL Recommendation -> 后退 -> 前进 -> 刷新，最终仍为
AWOL 项目，Recommendation `21`，存在 `valerion.com`，不存在 ElephTV 的 `amchimovie.com`。
390px 页面无横向溢出或控件重叠；键盘 Tab 焦点依次可见于导航和 AI Agent 控件。

进程重启后公开 API 和浏览器再次证明：

- Project：仍为 AWOL、ElephTV 两个 active 项目。
- Recommendation：AWOL `21`，首条 `valerion.com`，项目 meta 正确。
- Opportunity：目标记录仍为 `ACTIVE v3 / joinSequence 9` 且第一行。
- Draft：同一 Job `SUCCEEDED`，同一 Draft ID。
- Gmail：Eleph 同一 connection，AWOL 仍为 `null`。
- Links：Eleph `2`，AWOL `0`，Observation `3`。
- Model Run：仍为 `7`。
- AWOL Provider Ledger：仍为 `1`，成本 `27,600 micros`。

旧请求通过 AbortController/AbortSignal 取消，迟到结果按 Website Project query key 丢弃；快速切换和重启
没有产生第二个 Recommendation Job、Draft Job、Provider 调用或 AI 调用。

## 9. 集中测试

### Core

- `npm run verify:backlinks`：按要求仅执行一次。
- typecheck：PASS。
- lint：PASS。
- source manifest：`28` records，PASS。
- dependency allowlist：PASS。
- licenses：`693` packages，PASS。
- OpenAPI：`57` paths，PASS。
- migrations：`35` files，通过 `0042`。
- Unit：`87` files / `489` tests，PASS。
- API：`30` files / `101` tests，PASS。
- Contract：`26` files / `169` tests，PASS。
- Integration 首次结果：`1 failed / 48 passed / 4 skipped` files，
  `1 failed / 183 passed / 13 skipped` tests。
- 唯一失败是旧 Draft migration fixture 未装载 `0042` 的项目推荐上下文字段；修正 fixture 后定向重跑
  `draft-migration.test.ts`：`1` file / `8` tests，PASS；Core typecheck、lint 再次 PASS。

### FastAPI

- Ruff：PASS。
- pytest：`69 passed / 1 skipped`。

### Frontend

- typecheck：PASS。
- lint：PASS。
- build：PASS；仅保留既有大于 500 kB chunk 警告。
- Outreach source tests：全部 `13` 个 `*.test.mjs` 文件、`45` 个测试 PASS。
- Playwright desktop：`3/3` PASS。
- Playwright 390px mobile：`1/1` PASS。
- Playwright keyboard/a11y：`1/1` PASS。
- 自动化 Playwright 套件使用 fixture/intercept，不调用真实 Provider 或发送邮件；上述真实本地浏览器场景
  另行通过公开运行时完成。

### PostgreSQL 18

`verify-postgresql18.ps1` 已更新为验证当前 Backlinks migration `0028..0042` 和 `75` 张表，而不是旧的
`0028..0032` / `68` 张表。最终结果：

- clean install：PASS。
- existing upgrade 和 DataForSEO write compatibility：PASS。
- backup / restore：PASS。
- 恢复后：`75` tables、`3` recovery facts。
- RPO：`0.276s`。
- RTO：`110.157s`。
- 一次性数据库资源已自动清理，正式本地数据库未清空。

## 10. 扫描与副作用边界

- Outreach/Project 产品源码不存在 ElephTV、AWOL 或 Gmail 地址写死。
- Frontend 不引用 private Core `7301`，Outreach 旧 handwritten client 和 mock-data 已移除。
- Outreach 中剩余静态数组仅为视图枚举、允许状态和编辑器配置，不是业务数据。
- Project query key 均包含 Website Project key，读请求使用 AbortSignal。
- 日志未发现 Bearer Authorization、access token、refresh token、client secret、authorization code、
  private key 或原始邮件正文泄露。
- 源码中的 token 字样仅为 Gmail secret schema/repository 字段名和测试契约，不是 Secret 值。
- DataForSEO：本轮恰好 `1` 次真实付费调用；最终重启后已关闭。
- AI：`0` 次新增调用。
- Gmail send：`0`；Gmail sync：`0`。
- 未清空数据库或 Temporal，未执行 GSC，未新建监控体系。
- 未 commit，未 push。
- 未执行 `QUALITY-BACKLOG-001`。

## 11. 浏览器证据

- `output/playwright/local-product-013-awol-recommendations-mobile.png`
- `output/playwright/local-product-013-mobile-keyboard-focus.png`
- `output/playwright/local-product-013-rapid-switch-final.png`
- `output/playwright/local-product-013-after-restart-awol.png`
- `output/playwright/local-product-013-after-restart-draft.png`

## 12. 最终判定

`PASS_LOCAL_PRODUCT_UX`

010-012 的代码、公开 API、真实本地 UI、PostgreSQL/Temporal 持久化和刷新/重启恢复均已贯通。任意
Website Project 的 domain、国家、语言、产品、关键词和目标 URL 现在作为同一产品链的输入，不再以
ElephTV、AWOL 或 seed 名称作为成立条件。LOCAL-PRODUCT-013 到此停止。
