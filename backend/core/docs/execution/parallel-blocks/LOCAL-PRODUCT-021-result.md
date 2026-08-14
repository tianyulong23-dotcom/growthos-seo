# LOCAL-PRODUCT-021 已知外链直接验证和分层持续监控

- 执行日期：`2026-08-07`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-021`
- 最终状态：`PASS_CODE_PROVIDER_INPUT_REQUIRED`
- Branch：`外链part`
- Baseline HEAD：`d796989207cd7dfdec4c0a3fdbc46f855bf0fff9`
- Stop boundary：未执行 `LOCAL-PRODUCT-022`

## 1. 结论

用户已有外链、Provider Inventory 和 Outreach Placement 已接入同一套 Inventory 分层监控。
PostgreSQL 保存监控策略、Run 和不可变 Observation，Temporal 执行 durable 直接验证，Core 根据证据和
历史事务性决定业务状态。Provider 状态与来源页直接验证状态保持为两层独立事实：

- DataForSEO 的 new/lost/changed 只能提升监控优先级并产生 Provider 证据；
- Provider lost 不会直接确认 Placement `LOST`；
- 单次 SafeFetch/Browser 失败记录为 `INACCESSIBLE`，不会确认链接丢失；
- `CHANGED`、`LOST` 默认需要连续证据或用户确认，恢复追加 `RECOVERED` 生命周期事件。

ElephTV 的真实已存在来源页已通过 SafeFetch 完成 `VALID`，Temporal Workflow、业务 Run、Observation、
Policy 和 `nextCheckAt` 在 Worker/整套本地产品重启后仍然存在。020 没有可用的真实 Provider
Inventory 候选：DataForSEO 当前关闭，预算剩余 `17,200 micros`，低于受控调用预计
`27,600 micros`。因此未伪造 Provider 候选，本轮状态为 `PASS_CODE_PROVIDER_INPUT_REQUIRED`。

## 2. 数据模型与迁移

新增 migration：

```text
0051_backlink_inventory_monitoring.sql
```

Migration checksum：

```text
a904d372a2520c4b21caf8999a224ceb768ac54cc561ef16921b0079cbe1ad98
```

0051 完成以下事实模型：

- 扩展 `backlink_inventory_items`，保存 direct health/validation、最后检查、限制原因、备注和最新直接证据；
- `backlink_inventory_monitor_policies`：Tier、重要性、启停、policy version、周期和 next check；
- `backlink_inventory_monitor_runs`：durable Job、调度时间、重试和终态；
- `backlink_inventory_monitor_observations`：append-only 的直接验证证据；
- `backlink_inventory_monitor_requests`：立即检查的幂等请求；
- Placement 自动合并到 Inventory，不重复计数；
- 已有 Placement 和 Inventory 的幂等回填；
- 所有新增表的 RLS、租户索引、约束、Grant 和 deployment manifest 注册。

每条可直接验证的 Inventory 都有 Tier、policy version 和 `nextCheckAt`；不能直接验证的记录必须保留
明确的 provider-only/restriction 原因。

## 3. 分层监控与状态机

默认策略：

| Tier | 对象 | 默认周期 |
| --- | --- | --- |
| A | Placement、Pinned/Managed、Provider new/lost/changed | 1 天 |
| B | 高质量或高业务价值 Inventory | 7 天 |
| C | 长尾普通 Inventory | 30 天 |

直接验证复用现有 Placement Monitor 的 SafeFetch、Cheerio、tldts、SSRF/Redirect 门禁和共享 Browser
fallback 边界，检查状态码、最终 URL、目标链接、Anchor、rel token、nofollow/sponsored/ugc、
Meta/X-Robots noindex 和 Canonical。

支持状态：

```text
VALID
CHANGED
SUSPECTED_LOST
LOST
RECOVERED
INACCESSIBLE
```

Worker 只返回证据，不直接修改 Placement。Core 在单个 PostgreSQL transaction 中写入 Observation、
更新 Inventory/Policy/Run，并追加生命周期事件。确定性 Workflow ID、Run 幂等和毫秒精度调度比较
避免重复检查及空循环。

## 4. API、契约与前端

FastAPI Gateway、Backlinks OpenAPI、aggregate Platform OpenAPI 和 generated clients 已同步。
公开能力包括：

- 查询项目 Inventory 及 Provider/Direct 双状态；
- 幂等导入已有 source URL + target URL；
- 调整 Tier/重要性；
- 暂停或恢复监控；
- 发起同一套 durable Job 的立即检查；
- 查询不可变的直接验证历史。

Links 页面现在显示：

- Provider 状态与 Direct Validation 状态的区别；
- 最后检查、下次检查、Tier、重要性、证据和限制原因；
- 标记重点、暂停/恢复、立即检查；
- Observation 历史；
- 已有外链导入表单；
- 项目切换后的独立请求和状态，不使用跨项目缓存。

## 5. 真实本地验收

真实 ElephTV Inventory：

```text
inventoryItemId: 6fdfa083-1f8e-57d0-bbb8-3498e0bb32c9
sourceUrl: https://elephtv.africa/
targetUrl: https://elephtv.com/become-an-elephtv-reseller/
sourceType: USER_IMPORTED
provider: user_import
directValidationStatus: VALID
directHealthStatus: active
tier: A
monitoringEnabled: true
lastDirectCheckedAt: 2026-08-07T01:06:45.309Z
nextCheckAt: 2026-08-08T01:49:05.309Z
```

真实 Temporal 执行：

```text
workflowId:
backlinks:11111111-1111-4111-8111-111111111111:
cec65d3f-92e5-4b13-aa26-7b39e74e213a:
e0bfde33-54bd-454a-ab61-cf7a4a48dcf0:
placement-monitoring:v1:921522b3-c350-5f00-8de5-cabb794cf469

temporalRunId: 019fd9c2-1417-7e23-9e8b-5e9849e0f948
businessRunId: 921522b3-c350-5f00-8de5-cabb794cf469
status: SUCCEEDED
attemptCount: 1
result: present
observationId: e6da3e61-6397-4e90-83f4-bb0660afb70e
directValidationStatus: VALID
```

相同 source/target 连续两次通过公开 Gateway 导入，均返回同一个 Inventory ID 且
`replayed=true`。导入前后真实数据库计数保持：

```text
Inventory: 1
Opportunity: 9
EmailDraft: 3
SendIntent: 0
```

这证明已有外链导入不依赖或伪造 Outreach、Opportunity、Email 和发送历史。

Worker 和整套本地产品重启后，Policy、成功 Run、Observation、`VALID` 和未来 `nextCheckAt` 均恢复；
调度器没有因 PostgreSQL microsecond 与 JavaScript millisecond 精度差异反复创建空 Workflow。

## 6. 自动化状态机与隔离证据

受控测试覆盖：

- `CHANGED -> LOST -> RECOVERED` 连续证据状态机；
- 单次缺失只进入 `SUSPECTED_LOST`；
- 单次抓取失败进入 `INACCESSIBLE`；
- Provider lost 不直接确认业务 `LOST`；
- 401/403/429/Captcha/Login/Paywall 的有界限制处理；
- Redirect、rel、noindex、canonical 和 Browser fallback；
- 立即检查幂等复用 durable Job；
- Tier A/B/C 调度、暂停/恢复和 next check；
- Organization/Workspace/Website Project RLS；
- 两项目调度、Run、Observation 和事件隔离，无重复检查。

受控本地页面产生的 `CHANGED/LOST/RECOVERED` 仅作为自动化状态机证据，与 ElephTV 真实 URL 的
`VALID` 证据分开记录。

## 7. 验证证据

| 验证 | 结果 |
| --- | --- |
| 0051 migration integration | `7/7` |
| Monitoring migration / RLS / state model | `12/12` |
| Monitor policy/workflow/process targeted pack | `42/42` |
| Related direct-validation unit tests | `11/11` |
| Core typecheck / build | PASS / PASS |
| FastAPI gateway/shared contracts | `23/23` |
| FastAPI Ruff（涉及文件） | PASS |
| Backlinks migration manifest | `44` files through `0051` |
| Backlinks OpenAPI baseline | `69` paths |
| Backlinks generated client | `70` operations |
| Platform generated client | `6` operations |
| Frontend typecheck / scoped lint / build | PASS / PASS / PASS |
| Frontend Links source tests | `6/6` |
| Desktop Playwright | `1/1` |
| Mobile 390px Playwright | `1/1`, no page overflow |
| Keyboard + serious a11y | `1/1` |
| `git diff --check` | PASS（仅现有 LF/CRLF warning） |

真实运行中额外发现并修复：

1. PostgreSQL prepared statement 的 UUID/text 参数推断冲突；
2. data-modifying CTE 插入 Job 后从基础表读取不可见，导致 Run 未创建；
3. PostgreSQL microsecond 与 Temporal/Node millisecond 精度不一致导致到期任务空循环；
4. 完成阶段 lifecycle event 参数类型和无效占位符冲突；
5. Inventory + Policy JOIN 的 `id` 未限定导致公开 Gateway 查询 HTTP 500。

这些缺陷均增加了 PostgreSQL integration 回归，并在真实 Core/Temporal/Gateway 链重新验证。

## 8. 最终运行状态

最终本地运行 ID：

```text
20260807-091909
```

| 组件 | 结果 |
| --- | --- |
| Frontend `http://localhost:5173` | HTTP 200 |
| Links `http://localhost:5173/projects/elephtv/backlinks/links` | HTTP 200 |
| FastAPI `http://localhost:7200` | HTTP 200 |
| Inventory / History API | HTTP 200 / HTTP 200 |
| Private Core `http://127.0.0.1:7301` | HTTP 200 |
| PostgreSQL 18 | healthy / head `0051` |
| Temporal | healthy / Workflow completed |
| DataForSEO | disabled |
| Browser fallback | disabled；本次真实 VALID 使用 SafeFetch 完成 |
| AI / Gmail send / Gmail sync | disabled / disabled / disabled |

运行日志中的近期 `ClientDisconnect` 来自前端取消请求；当前 readiness 和公开 API 均正常。
结果文档和日志没有保存 Provider credential、API Key、Authorization header 或其他敏感凭据。

## 9. 剩余输入与边界

020 没有生成可用于本轮第三项真实验收的 Provider Inventory 候选。要关闭该 Acceptance Debt，需要：

1. 明确启用 DataForSEO；
2. 将可用预算提高到至少覆盖一次受控调用的 `27,600 micros`；
3. 继续经过 allowlist、kill switch、reservation、ledger 和最大调用次数门禁；
4. 对得到的一条 Provider new/lost/changed 候选执行同一套直接验证。

当前代码、Migration、Contract、UI、真实 SafeFetch、Temporal、重启恢复和项目隔离均已完成。任务在
`PASS_CODE_PROVIDER_INPUT_REQUIRED` 停止，未执行 `LOCAL-PRODUCT-022`，未 commit、未 push。
