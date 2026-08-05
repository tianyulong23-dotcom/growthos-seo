# LOCAL-REAL-004 推荐池前端与加入机会

- 执行日期：`2026-08-04`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-REAL-004`
- 状态：`PASS_LOCAL_FUNCTION`
- 当前 Website Project：`elephtv`
- 最终运行 ID：`20260804-211836`
- 本地产品入口：`http://localhost:5173/projects/elephtv/backlinks/recommendations`

## 1. 结论

当前真实 ElephTV Website Project 已完成以下本地业务闭环：

```text
PostgreSQL Ready Recommendation
-> 查看真实网站
-> 查看公开邮箱与 Evidence
-> 用户选择联系人
-> 创建 Opportunity
-> Recommendation/Inventory 原子更新为 accepted
-> 打开真实 Opportunity
```

桌面和 `390x844` 均已通过真实浏览器验证。页面没有 mock、fixture、canary Project、
公网发布或前端自行推导业务状态。

## 2. 本轮实现

### 2.1 Recommendation 公共读模型

Recommendation API 现在按当前 Project 投影并返回：

- 真实 `rootUrl`、favicon、评分、匹配理由、SEO 指标、采集时间和数据来源；
- 联系人状态、公开邮箱、用途、置信度、Evidence URL 和提取方式；
- enrichment job 进度、最近错误和重试入口；
- 推荐联系人、现有 Opportunity、服务端加入资格和禁用原因。

所有 Recommendation、Prospect、ContactCandidate、ContactEvidence、Job 和 Opportunity
关联均在 PostgreSQL 查询中按 organization/workspace/project/context 约束。

### 2.2 加入 Opportunity 门禁

创建命令新增 `contactCandidateId`，Core 在事务内验证：

1. Recommendation/Inventory 属于当前 Project 且状态为 `ready/shown`；
2. Candidate 属于同一 Prospect 和 Recommendation Context；
3. 邮箱语法有效，且不是 placeholder、no-reply 或保留示例域名；
4. 存在未失效的 `mailto`、`visible_text`、`obfuscated_text`、`json_ld` 或 `manual` Evidence；
5. 当前 Project 内该 registrable domain 尚无 Opportunity。

外部邮箱域名、unknown purpose、低置信或 guessed 候选不再阻止创建，而是保存
`contactReviewRequired=true`。无合格邮箱仍禁止加入。

Opportunity 保存 `sourceContactCandidateId` 和 `contactReviewRequired`，创建成功后才将
Recommendation 和 Inventory 更新为 `accepted`。相同 idempotency key 会回放原结果，
不会创建重复 Opportunity。

### 2.3 前端体验

Recommendation 页面已支持：

- `全部`、`有联系人`、`抓取中`、`需复核`、`暂无联系人`过滤；
- 同行查看真实网站、联系人用途/置信度和公开 Evidence；
- 重新抓取与人工补充公开联系人；
- 无合格联系人时禁用“加入 Opportunity”；
- 创建后跳转 Opportunity 页面，并自动打开新记录详情；
- Opportunity 详情显示“联系人需复核”状态。

### 2.4 契约、Migration 与启动

- 新增 migration `0039_backlink_opportunity_contact_gate.sql`。
- 部署 manifest head 更新为 `0039`。
- 共享 Backlinks OpenAPI、Platform OpenAPI 和 generated client 已同步。
- 本地启动脚本会检查并应用 `0039`，状态脚本读取真实 migration/列/FK 状态。
- Core 重建并重启后，Gateway 返回新 Recommendation 和 Opportunity 字段。

## 3. 真实运行验证

### 3.1 桌面路径

真实网站：

```text
weekendspecial.co.za
website=https://weekendspecial.co.za/
evidence=https://weekendspecial.co.za/editorial-team/
contact=jane@weekendspecial.co.za
purpose=editorial
confidence=90
```

浏览器实际打开了网站和 Evidence 页面，并创建：

```text
opportunityId=fe475ba8-3360-43f8-a04e-ec4706f11afd
sourceContactCandidateId=42b664be-e4cd-40f9-bb39-8e26cbe8476c
contactReviewRequired=false
```

证据截图：

- `output/playwright/LOCAL-REAL-004-desktop-list.png`
- `output/playwright/LOCAL-REAL-004-desktop-opportunity.png`

### 3.2 390px 路径

真实网站：

```text
stuff.co.za
website=https://stuff.co.za/
evidence=https://stuff.co.za/category/news/ai-news/page/138/
contact=stuff@stuff.co.za
purpose=unknown
confidence=80
```

浏览器实际打开了网站和 Evidence 页面，并创建：

```text
opportunityId=66d446d9-616b-4b6a-bfdb-706699019793
sourceContactCandidateId=8ca6fddd-33bd-484f-9dd6-1b64e61d50fc
contactReviewRequired=true
```

Opportunity 详情在 `390x844` 明确显示“联系人需复核”。

证据截图：

- `output/playwright/LOCAL-REAL-004-390-list.png`
- `output/playwright/LOCAL-REAL-004-390-opportunity.png`

### 3.3 门禁和隔离

| 验证项 | 真实结果 |
| --- | --- |
| 跨 Project 读取 | `not-elephtv` 返回 HTTP `403` |
| 无联系人禁用 | `2oceansvibe.com` 与 `streamwatchguide.com` 的加入按钮 disabled |
| 普通联系人 | `weekendspecial.co.za` 创建后 `contactReviewRequired=false` |
| 需复核联系人 | `stuff.co.za` 创建后 `contactReviewRequired=true` |
| 重复提交 | 两条创建请求使用原 idempotency key 均返回原 opportunityId，`replayed=true` |
| 重复 domain | Core integration test 验证同 Project/domain 第二条 Recommendation 返回 duplicate |
| 库存更新 | Ready Recommendation 从 `18` 降至 `16` |
| 数据库状态 | 两条 Recommendation/Inventory 均为 `accepted` |

数据库最终事实：

```text
stuff.co.za
| opportunity=66d446d9-616b-4b6a-bfdb-706699019793
| contactReviewRequired=true
| recommendation=accepted
| inventory=accepted

weekendspecial.co.za
| opportunity=fe475ba8-3360-43f8-a04e-ec4706f11afd
| contactReviewRequired=false
| recommendation=accepted
| inventory=accepted
```

## 4. 改动相关验证

按 V1.1 规则仅执行改动相关测试和一次真实运行验证，没有执行全仓库综合 Gate。

| 范围 | 结果 |
| --- | --- |
| Core Recommendation/Opportunity/API 定向测试 | PASS |
| Opportunity integration 与本地启动脚本测试 | PASS |
| Core typecheck/build | PASS |
| Frontend Recommendation source tests | `2/2` passed |
| Frontend typecheck/build | PASS |
| Frontend 定向 ESLint/Prettier | PASS |
| Backlinks OpenAPI | `54` paths valid |
| Platform OpenAPI | `76` public paths，`82` operations |
| Generated Backlinks client | `55` operations |
| Database migrations | `32` files，head `0039` |
| 定向 Playwright | 桌面与 `390x844` PASS |

浏览器产品页没有 JavaScript 运行错误；控制台仅有第三方
`streamwatchguide.com/favicon.ico` 返回 HTTP `404`，不影响产品流程。

## 5. 最终本地运行状态

`Status-GrowthOS-LocalProduct.ps1`：

```text
status=ok
runtimeMode=LOCAL_PRODUCT
runId=20260804-211836
projectKey=elephtv
backlinksHead=0039
```

| 组件 | 地址 | 状态 |
| --- | --- | --- |
| React SPA | `http://localhost:5173` | HTTP `200` |
| FastAPI Gateway | `http://localhost:7200` | HTTP `200` |
| Private Fastify Core | `http://127.0.0.1:7301` | HTTP `200` |
| Shared Browser Worker | `http://127.0.0.1:7401` | HTTP `200` |
| PostgreSQL 18 | `127.0.0.1:55432` | healthy，migration `0039` |
| Temporal | `127.0.0.1:57233` | healthy，namespace ready |

## 6. 最终状态

```text
PASS_LOCAL_FUNCTION
```

- `INPUT_REQUIRED=NONE`。
- 未执行 Git commit/push。
- 未撤销用户已有改动。
- 未执行公网发布。
