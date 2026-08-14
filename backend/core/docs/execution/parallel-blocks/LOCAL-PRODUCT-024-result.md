# LOCAL-PRODUCT-024 “加入机会”交互与机会排序修复结果

- 执行日期：`2026-08-07`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-024`
- 最终状态：`PASS`
- 本地运行 ID：`20260807-161829`
- Stop boundary：未执行 `LOCAL-PRODUCT-025..027`

## 1. 结论

`LOCAL-PRODUCT-024` 已完成：

1. Recommendation 到 Opportunity 仍由用户显式点击触发。
2. 创建成功后不再自动跳转、打开详情、进入草稿或启动发送。
3. 用户继续停留在推荐池；成功行立即显示禁用的“已加入”，并通过 Live Region 宣告成功。
4. 连续真实加入两个不同网站后，数据库各只有一条 Opportunity。
5. Opportunity 列表继续使用 Core 的 `join_sequence DESC, id DESC` 服务端排序，后加入的网站位于更上方。
6. 两条新 Opportunity 在用户显式进入详情/草稿页面前后都没有自动创建 Draft、Draft Job、SendIntent 或 Gmail Thread。
7. 详情和草稿流程仍可由用户显式点击进入；草稿页保持 `IDLE / 等待用户提交`。
8. 保留现有 Core 生命周期权威、PostgreSQL 业务事实、幂等记录、Temporal、预算 Ledger、缓存和 Kill Switch；没有新增 Provider、Queue、Crawler 或业务数据模型。

旧 Result 不改写。旧的“创建成功后自动跳转并带 `opportunityId` 打开详情”UX 已由本任务的新行为替代。

本轮未 commit、未 push，未清理、撤销或覆盖工作树中的无关改动。

## 2. 最小实现范围

本轮只修改：

```text
frontend/src/features/outreach/recommendations/recommendations-workspace.tsx
frontend/src/features/outreach/recommendations/recommendations-source.test.mjs
backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-024-result.md
```

前端行为：

- 使用单请求锁和行级 busy 状态防止重复点击。
- 只在 Core 返回真实 `opportunityId` 后记录当前行已加入状态。
- 成功后保留当前路由，不再导航到 Opportunity 详情。
- 成功行显示禁用的“已加入”和行内说明。
- 使用 `role="status"`、`aria-live="polite"` 提供非阻断式成功反馈。
- 失败时释放请求锁、恢复按钮，并在当前行显示 `role="alert"` 错误。
- 不在失败路径生成任何前端假 Opportunity。

对应实现位置：

```text
recommendations-workspace.tsx:241-342
recommendations-workspace.tsx:402
recommendations-workspace.tsx:617-653
recommendations-source.test.mjs:54-58
```

未修改 Core 创建、生命周期转换、幂等和排序实现。现有权威路径继续使用：

```text
opportunity.repository.ts:77
opportunity.repository.ts:167
opportunity.repository.ts:296
opportunities.query.ts:240
```

## 3. 真实推荐与 Opportunity 结果

项目：

```text
websiteProjectKey: awolvision-com-4ec81dca
websiteProjectId:  4ec81dca-a0d0-40f3-9ff1-9cdff6613924
```

本轮只选择已经通过公开邮箱发布门禁的推荐：

| 加入顺序 | 推荐网站 | 脱敏公开邮箱 | 发布状态 | 公开邮箱数 | 公开证据页 | Opportunity | join_sequence |
| --- | --- | --- | --- | ---: | --- | --- | ---: |
| 1 | `stuff.co.za` | `s***@stuff.co.za` | `PUBLISHED` | 1 | `https://stuff.co.za/category/news/app-news/page/2/` | `1f7f9dee…530e0` | 6 |
| 2 | `bizcommunity.com` | `s***@bizcommunity.com` | `PUBLISHED` | 1 | `https://www.bizcommunity.com/SubmitNews.aspx` | `5a0be567…01c7` | 7 |

真实创建时间：

```text
stuff.co.za:      2026-08-07T08:49:35.137Z
bizcommunity.com: 2026-08-07T08:50:02.942Z
```

数据库重复检查：

```text
stuff.co.za:      1
bizcommunity.com: 1
```

Opportunity 总数由 `5` 增加到 `7`，与两次显式加入一致。

## 4. 路由、反馈与详情副作用

两次点击前后的页面 URL 都是：

```text
http://localhost:5173/projects/awolvision-com-4ec81dca/backlinks/recommendations
```

第一次成功：

```text
stuff.co.za 已加入 Opportunity。你仍在推荐池中。
```

第二次成功：

```text
bizcommunity.com 已加入 Opportunity。你仍在推荐池中。
```

两行按钮均变为禁用的：

```text
已加入
```

两次操作都没有出现 Modal、Drawer、详情页或阻断式成功弹窗。

进入 Opportunity 页面时 URL 不带 `opportunityId`，页面没有自动打开详情：

```text
http://localhost:5173/projects/awolvision-com-4ec81dca/backlinks/opportunities
```

用户显式点击 `bizcommunity.com` 的“详情”后，才进入：

```text
/backlinks/opportunities?opportunityId=5a0be567-cd4c-49ee-bc53-a6163f7801c7
```

详情中保留现有“撰写邮件”入口。用户再次显式点击后进入：

```text
/backlinks/drafts/new?opportunityId=5a0be567-cd4c-49ee-bc53-a6163f7801c7
```

草稿页显示：

```text
IDLE
等待用户提交
服务端尝试次数 0
```

没有自动提交“生成草稿”。

## 5. 服务端排序事实

Core 查询保持：

```sql
ORDER BY o.join_sequence DESC,o.id DESC
```

真实 Gateway 返回前两项：

| 顺位 | 网站 | join_sequence | createdAt |
| ---: | --- | ---: | --- |
| 1 | `bizcommunity.com` | 7 | `2026-08-07T08:50:02.942Z` |
| 2 | `stuff.co.za` | 6 | `2026-08-07T08:49:35.137Z` |

浏览器机会页顺序与 Gateway 一致。没有使用浏览器临时置顶或本地创建时间排序。

## 6. 邮件生命周期隔离

两条新 Opportunity 的数据库终态：

| 网站 | EmailDraft | Draft Request Snapshot | Draft Job | SendIntent |
| --- | ---: | ---: | ---: | ---: |
| `stuff.co.za` | 0 | 0 | 0 | 0 |
| `bizcommunity.com` | 0 | 0 | 0 | 0 |

AWOL 项目 Gmail Thread：

```text
0
```

显式打开详情和草稿表单后再次核对，以上计数仍全部为 `0`。Recommendation 到 Opportunity 的转换没有推进 Email 生命周期。

## 7. Provider 脱敏证据与预算账本

### 7.1 官方账户与内部预算分离

| 项目 | 事实 |
| --- | --- |
| DataForSEO 官方账户余额 | 本轮未调用官方余额接口，不记录或推测数值 |
| 现有 Secret Reference | `secret://growthos/local-product/dataforseo/***/v1` |
| GrowthOS 当前内部周期上限 | `1,000,000 micros` |
| 本轮 024 基线已消费 | `478,980 micros` |
| 本轮 024 最终已消费 | `478,980 micros` |
| 本轮消费变化 | `0 micros` |
| 最终预留 | `0 micros` |
| 最终内部剩余 | `521,020 micros` |

官方账户余额和 GrowthOS 内部预算不是同一事实。本轮没有重置预算周期，也没有改写历史 Ledger。

### 7.2 024 前后的账本

本轮基线冻结时间：

```text
2026-08-07T08:48:16.840Z
```

最终核对时间：

```text
2026-08-07T09:01:36.474Z
```

| 指标 | 024 基线 | 024 最终 | 变化 |
| --- | ---: | ---: | ---: |
| DataForSEO Provider Request | 27 | 27 | 0 |
| DataForSEO Ledger Entry | 24 | 24 | 0 |
| 当前周期 spent_micros | 478,980 | 478,980 | 0 |
| 当前周期 reserved_micros | 0 | 0 | 0 |
| 当前 Budget version | 41 | 41 | 0 |

注意：`LOCAL-PRODUCT-023-result.md` 记录的较早终态为 `427,344 micros`。数据库显示在本轮 024 基线冻结前的 `2026-08-07T08:44:09.869Z` 已存在两条后续真实请求：

| 脱敏 Request ID | Endpoint | 状态 | 实际成本 |
| --- | --- | --- | ---: |
| `fac246a7…5352` | `/v3/backlinks/summary/live` | succeeded/settled | 24,036 |
| `7a36077c…13f2` | `/v3/backlinks/backlinks/live` | succeeded/settled | 27,600 |

两条合计 `51,636 micros`，解释了 `427,344 -> 478,980`。它们发生在 024 验收基线之前。024 的两次 Opportunity 创建、页面导航、详情和草稿表单读取均未增加 Provider Request 或预算消费。

DataForSEO 仍为 `enabled=true`，项目和 Provider Kill Switch 均保持 `blocked=false`；缓存、幂等和历史账本均保留。

## 8. 桌面、390px 与键盘验收

桌面浏览器验证：

- 推荐池连续加入两站点，路由不变。
- 两个按钮显示“已加入”。
- 机会页默认无详情。
- 服务端顺序为 `bizcommunity.com`、`stuff.co.za`。
- 显式点击详情后才出现详情 Drawer。

390px 浏览器验证：

- 机会列表、筛选、状态和详情入口可读取。
- Drawer 在 390px 下可用，没有文本覆盖关键命令。
- 键盘焦点位于“详情”按钮时按 `Enter`，显式打开对应详情。
- 再显式进入草稿页后，表单完整显示，状态为 `IDLE`。

截图证据：

```text
frontend/output/playwright/local-product-024-recommendations-before.png
frontend/output/playwright/local-product-024-recommendations-after-two-adds.png
frontend/output/playwright/local-product-024-opportunities-server-order.png
frontend/output/playwright/local-product-024-explicit-detail.png
frontend/output/playwright/local-product-024-mobile-390-opportunities.png
frontend/output/playwright/local-product-024-mobile-390-keyboard-detail.png
frontend/output/playwright/local-product-024-mobile-390-draft-idle.png
```

## 9. 验证命令

Frontend 定向测试：

```powershell
cd frontend
node --test src/features/outreach/recommendations/recommendations-source.test.mjs src/features/outreach/opportunities/opportunities-source.test.mjs
```

结果：

```text
5 tests passed
```

Frontend Typecheck、Lint、Build：

```powershell
npm run typecheck
npm run lint
npm run build
```

结果：全部 `PASS`。Vite 只有现有大 chunk warning，没有 build failure。

Core API 与 PostgreSQL 行为：

```powershell
cd backend/core
npx vitest run test/backlinks/api/opportunities-route.test.ts
npx vitest run test/backlinks/integration/opportunity-create.command.test.ts test/backlinks/integration/opportunity-query.test.ts
```

结果：

```text
3 test files passed
3 tests passed
```

这些测试覆盖服务端降序、同一 Recommendation 重放只创建一个 Opportunity，以及真实 PostgreSQL 查询顺序。

运行态：

```powershell
.\Status-GrowthOS-LocalProduct.ps1 -Json
```

结果：

```text
status=ok
Frontend HTTP 200
FastAPI HTTP 200
Private Core HTTP 200
PostgreSQL healthy
Temporal healthy
DataForSEO enabled
Gmail send disabled
Gmail sync disabled
```

差异检查：

```powershell
git diff --check -- frontend/src/features/outreach/recommendations/recommendations-workspace.tsx frontend/src/features/outreach/recommendations/recommendations-source.test.mjs backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-024-result.md
```

## 10. 最终边界

最终状态：

```text
PASS
```

本轮已经完成并停止。未执行 `LOCAL-PRODUCT-025`、`LOCAL-PRODUCT-026` 或 `LOCAL-PRODUCT-027`。
