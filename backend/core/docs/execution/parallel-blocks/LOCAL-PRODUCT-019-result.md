# LOCAL-PRODUCT-019 真实 Gmail 发送、回复和持续同步

- 执行日期：`2026-08-06`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-019`
- 最终状态：`PASS_CODE_EXTERNAL_ACTION_PENDING`
- Branch：`外链part`
- Baseline HEAD：`d796989207cd7dfdec4c0a3fdbc46f855bf0fff9`
- Stop boundary：未执行 `LOCAL-PRODUCT-020`

## 1. 结论

Draft 到 Gmail Provider Accepted、Connection 级 Polling Sync、Inbound Message 持久化和
Opportunity/Website Project 匹配的代码链已经完成。实现继续复用现有 Core、PostgreSQL、Temporal、
FastAPI Gateway、Gmail Adapter 和 generated client，没有创建第二套队列、邮箱游标或业务权威。

本轮没有代替用户执行“人工批准”和“最终确认并发送”，也没有等待或伪造真实收件人回复。当前真实
AWOL 草稿仍为 `待审批`，Gmail Send/Sync capability 保持关闭，数据库发送与同步事实均为 `0`。
因此按任务规则记录为 `PASS_CODE_EXTERNAL_ACTION_PENDING`；代码阶段完成，不阻塞独立的
`LOCAL-PRODUCT-020/021`。

## 2. 发送链

发送路径现在执行以下硬门禁：

1. 只解析当前 Website Project 选择的 Organization GmailConnection。
2. 在 Send Policy 和 Provider 调用之前，立即执行 Token Refresh Health Check。
3. SendIntent 必须引用当前批准版本对应的 `draft.approval.recorded` 生命周期事实。
4. Approval Snapshot 固化 approval fact、批准人、批准时间、草稿版本和收件人，不接受后续正文替换。
5. 幂等键由 project、draft、approved draft version、规范化 recipient、approval fact 和发送用途组成。
6. Provider Accepted 后先持久化 SendAttempt、RFC Message-ID、provider message/thread ID 和
   `PROVIDER_ACCEPTED`，再 ensure Connection 级 Polling Workflow。
7. Unknown Outcome 继续保持不可自动重发，必须先按 Message-ID/Provider 状态恢复。

真实页面仍要求用户先点击“人工批准”。批准后才显示最终正文、发送身份、收件人、版本和显式确认
checkbox；未勾选时“最终确认并发送”不可执行。AI 不能批准、发送或改变邮件业务状态。

## 3. Connection 级回复同步

Gmail Polling Workflow 和 Cursor 已改为 Organization/Workspace/Connection 级：

- 同一 Connection 只有一个 durable polling workflow；
- “立即同步”只 signal 现有 workflow，不创建每项目同步器；
- `backlink_gmail_connection_sync_cursors` 以 Connection 为唯一邮箱游标，不复制项目 cursor；
- 仅为当前有效项目选择、当前 Connection、已 Provider Accepted outbound thread 和启用的
  `GMAIL_SYNC` lane 建立路由；
- 初始同步和增量同步只拉取产品 thread 或受控时间窗候选，不展示无关私人邮件；
- Gmail message/thread ID、history cursor 和项目消息写入均有幂等保护；
- `invalid history/cursor` 进入有界 repair，不执行无限全邮箱回扫；
- Gmail 临时错误只暂停该 Connection，不暂停推荐、联系人或其他项目。

Inbound Message 在写入项目表之前会再次验证当前项目 mailbox binding、Connection、accepted send
thread 和 kill switch。一个 Provider Thread 若同时命中多个项目会停止自动路由，不能把邮件写入错误
项目。匹配继续按 RFC Message-ID、Provider Thread ID、发送事实和项目映射执行；高置信可自动确认，
歧义进入人工确认。AI 不自动回复。

## 4. Migration 与恢复

新增 migration：

```text
0049_backlink_gmail_send_reply_loop.sql
```

它完成：

- Send Approval Snapshot 的 approval fact/actor/time 字段、完整性约束和生命周期事实外键；
- Connection 级 Gmail Sync Cursor、Workspace Binding 外键、RLS 和 grant；
- migration manifest、Start/Status 脚本的 `0049` head 与结构检查。

Migration checksum：

```text
88b59164f3ffffcbba381fdcca260d770b2196f27a188ba36dd00b1715268c72
```

本地栈在迁移后完成 Core、Worker、FastAPI 和 Frontend 重启。重启后 PostgreSQL head 为 `0049`，
Temporal namespace ready，既有 AWOL 草稿仍可读取；发送事实、Cursor、Thread 和 Message 没有因重启
被重复创建。

## 5. 真实本地验收

真实 AWOL 草稿页使用 `http://localhost:5173` 验证：

- Desktop `1440x900` 正常显示草稿编辑、版本、主题、正文和人工批准入口；
- Mobile `390x844` 无页面级横向溢出、文本重叠或按钮遮挡；
- 刷新后仍恢复同一服务端草稿和 `待审批` 状态；
- 项目菜单同时显示 AWOL Vision 和 ElephTV；
- 切换到 ElephTV 后，同一个 AWOL 草稿明确返回“未找到该草稿，或草稿不属于当前项目”；
- 切回 AWOL 后草稿正常恢复；
- 未点击人工批准、未勾选最终确认、未调用 SendIntent API。

验收截图：

```text
output/playwright/local-product-019-desktop.png
output/playwright/local-product-019-mobile-390.png
```

浏览器控制台仍有一个既有 Base UI `nativeButton` 语义提示；键盘和 serious a11y 门禁通过，该提示不影响
本轮业务链。一次使用 `127.0.0.1:5173` 打开页面时被 CORS 拒绝，改用产品正式本地地址
`localhost:5173` 后 Gateway 请求均为 `200`。

## 6. 验证证据

| 验证 | 结果 |
| --- | --- |
| Gmail send/runtime/migration targeted pack | `5` files, `32/32` |
| SendIntent、initial/incremental sync、reply/auth integration pack | `6` files, `26/26` |
| Migration 0049 PostgreSQL integration | `3/3` |
| Backlinks migration manifest | `42` files through `0049` |
| Core typecheck/build | PASS |
| 019 targeted backend ESLint | PASS |
| Backlinks OpenAPI baseline | `61` paths |
| Source manifest check | `28` entries |
| Dependency allowlist / license gate | PASS / `693` packages |
| Backlinks generated client | `62` operations |
| Platform generated client | `6` operations |
| Frontend draft source tests | `6/6` |
| Frontend build | PASS |
| Live desktop/390px/refresh/project switch | PASS |
| Playwright mobile | `1/1` |
| Playwright keyboard + serious a11y | `1/1` |
| Desktop Playwright | `3/4`; 019 发送/回复链通过，1 个 018 polling 文案断言失败 |

Core 全量 ESLint 仍命中 015/016 商业推荐模块中的 `9` 个既有规则问题；019 涉及文件的定向 ESLint
通过，本轮没有扩大范围修改这些模块。Desktop Playwright 唯一失败项是 018 草稿生成页仍显示
“尚未成功查询”，真实 AWOL 草稿刷新和 019 fixture 发送/回复链均已通过。

## 7. 最终运行状态与零副作用

| 组件/能力 | 结果 |
| --- | --- |
| Frontend `http://localhost:5173` | HTTP 200 |
| FastAPI `http://localhost:7200` | HTTP 200 |
| Private Core `http://127.0.0.1:7301` | HTTP 200 |
| PostgreSQL 18 | healthy |
| Alembic head | `20260806_0009` |
| Backlinks head | `0049` |
| Temporal | healthy / namespace ready |
| Gmail Connection | 已存在并可由 AWOL 选择 |
| Gmail Send | disabled |
| Gmail Sync | disabled |
| SendIntent | `0` |
| SendAttempt | `0` |
| Provider Accepted | `0` |
| Approval Snapshot | `0` |
| Connection Sync Cursor | `0` |
| Mail Thread / Message | `0 / 0` |

日志与 result 未写入 Token、Authorization Code、PKCE、Client Secret、API Key、完整邮箱、完整主题、
完整正文、RFC Message-ID 或 Provider Message/Thread ID。浏览器取消请求产生的 `ClientDisconnect`
不作为业务 Gate 失败，后续 Gateway/Core 请求均正常。

## 8. 剩余人工验收

只剩任务明确规定的三个人工动作：

1. 用户在 AWOL 草稿页检查或编辑正文，并执行“人工批准”。
2. 用户核对脱敏收件人、最终版本和正文，勾选确认后最多发送 `1` 封真实邮件。
3. 用户控制的收件端真实回复；随后观察 Connection Polling 自动持久化并匹配正确 Opportunity。

恢复入口：

```text
http://localhost:5173/projects/awolvision-com-4ec81dca/backlinks/drafts/[REDACTED_DRAFT_ID]
```

真实发送后如结果为 unknown，不得再次点击发送，应先检查该 SendIntent/Message-ID 的恢复状态。若回复
匹配存在歧义，只能进入人工确认，不能自动跨项目绑定。本任务到此停止，未执行 `LOCAL-PRODUCT-020`。
