# LOCAL-REAL-006 Gmail 回复同步

- 执行日期：`2026-08-04`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-REAL-006`
- 状态：`PASS_WITH_EXTERNAL_ACTION`
- 当前 Website Project：`elephtv`
- 邮件中心：`http://localhost:5173/projects/elephtv/backlinks/email`

## 1. 结论

当前真实 ElephTV Website Project 已完成 Gmail 回复同步的本地运行闭环：

```text
已接受的真实 SendAttempt/providerThreadId
-> 当前 Workspace + GmailConnection 的持续轮询
-> Gmail History 增量读取
-> cursor 持久化与 Message 幂等写入
-> 回复匹配或人工确认队列
-> 邮件中心查看、绑定和解除绑定
```

当前项目尚未由用户批准并发送 005 的真实草稿，因此数据库中没有可用于建立当前项目同步范围的
`providerThreadId`，同步状态正确显示为 `WAITING_FOR_ACCEPTED_SEND`。这属于用户控制的真实
发送/回复边界，不是代码阻碍。

## 2. 本轮实现

### 2.1 持续轮询与本地启动

- 删除固定 canary send/subject 和固定 canary Project 限制。
- LOCAL_PRODUCT 从数据库读取当前 Project 已接受的真实 SendAttempt 和 `providerThreadId`。
- Temporal workflow 使用稳定 workflow ID 持续轮询，支持立即同步 signal 和
  continue-as-new；Worker 或完整本地进程重启后自动恢复。
- 轮询间隔可通过本地启动参数配置，范围 `15..3600` 秒，本轮为 `60` 秒。
- Provider 配置有效且显式启用 Gmail Sync 时，启动脚本自动打开当前 Project 的数据库
  Kill Switch。
- 未要求 Gmail push、canary allowlist、approvedBy、authorization window、publicBaseUrl、
  Tunnel、gcloud 或第二套 Worker/Queue。

### 2.2 Gmail History 与匹配

- 使用 Gmail history cursor 增量读取，并按 Provider message ID 幂等持久化 Message。
- 同步和匹配范围固定为 `Workspace + GmailConnection`。
- 匹配证据覆盖 thread ID、In-Reply-To、References、quoted fingerprint、Contact、
  subject、participants 和时间窗口。
- 唯一高置信候选可关联；歧义或未匹配回复保留在人工确认队列。
- 新增错误绑定解除命令、审计事件和 Gateway/OpenAPI/generated client 接线。
- 确认或解除回复关联均不自动推进 Opportunity 的 NEGOTIATING/AGREED 等业务阶段。

### 2.3 邮件中心

- 显示 Gmail 连接、同步状态、轮询间隔、可匹配发送数、Kill Switch、cursor 和最近同步时间。
- 邮件详情支持 thread、参与者、最新消息、Opportunity、匹配状态和匹配证据。
- 提供立即同步并刷新、重新授权、人工绑定、解除错误绑定和失败恢复入口。
- 当前真实页面显示 Gmail 已连接、间隔 `60` 秒、可匹配发送 `0` 条、Kill Switch 已开启，
  并明确提示当前 Project 尚未建立 Gmail History cursor。

## 3. 真实 Gmail 与持久化证据

为了在不伪造当前 Project 发送记录的前提下验证真实 Gmail 读取，本轮复用了同一真实 Gmail
连接下历史项目已经接受的真实发送 thread：

| 项目 | 结果 |
| --- | --- |
| 真实 Gmail thread | `19fc7f5a28477ffd`，包含真实 outbound 和 inbound reply |
| Gmail history cursor | `166995` 增量推进到 `167292` |
| 最后同步时间 | `2026-08-04T16:28:46.204Z` |
| cursor version | `11` |
| raw/messages/inbound/candidates | `4 / 4 / 2 / 2`，第二轮后数量不变 |
| 匹配结果 | 真实回复保持 `MATCH_CONFIRMED` |
| 阶段隔离 | 同步前后 Opportunity 业务阶段未被自动修改 |

验证 workflow 使用生产 Gmail Adapter 和现有共享 Temporal queue，未使用 mock/fixture。
验证完成后，历史项目 Kill Switch 已恢复为 fail-closed，临时输入文件已删除。

## 4. 重启恢复证据

当前 Project 的稳定 workflow ID 为：

```text
backlinks:cec65d3f-92e5-4b13-aa26-7b39e74e213a:e0bfde33-54bd-454a-ab61-cf7a4a48dcf0:gmail-polling-sync:v1:ce7b81a9-9023-4a0b-a1ba-371dca9fc737
```

Worker 和完整本地进程重启后，workflow 保持同一 run ID
`019fcd96-dad5-746b-9f20-018973dd3982` 并继续运行。历史真实 Gmail cursor 在重启后仍为
`167292`，Message 和候选数量没有重复增长。

## 5. 验证结果

- Core 改动相关测试：`6` 个文件、`26` 个测试通过。
- 最终启动脚本与回复匹配聚焦测试：`16/16` 通过。
- Gateway/shared contract 测试：`22/22` 通过。
- 前端邮件中心测试：`4/4` 通过。
- Reply repository 数据库集成测试：`5/5` 通过。
- Core TypeScript typecheck、production build：通过。
- Frontend TypeScript typecheck、production build：通过。
- PowerShell 启动脚本解析：通过。
- 真实浏览器桌面与移动端检查：页面正常渲染且无内容遮挡，控制台 `0` 个 error、`0` 个 warning。
- UI 立即同步请求：`POST .../sync` 返回 `202 Accepted`。
- 按 V1.1 要求，本轮未执行全仓库综合 Gate。

## 6. 最终运行状态

- Frontend `5173`、Gateway `7200`、Core `7301`、Browser Worker `7401` 均监听。
- PostgreSQL `55432` healthy，backlinks migration head `0039`。
- Temporal `57233` healthy，当前 Gmail polling workflow 正在运行。
- Gmail 连接状态为 `CONNECTED`，读取能力可用。
- 当前 Project 的 Gmail Sync Kill Switch 已自动开启。
- 本轮未暴露 token、authorization code、PKCE 或其他凭据。

## 7. 剩余外部动作

1. 用户在 005 草稿审核页批准并发送现有真实草稿，使当前 Project 产生已接受的
   `SendAttempt/providerThreadId`。
2. 由用户控制的真实收件人回复该邮件一次。

回复发生后，可等待最长一个 `60` 秒轮询窗口，或在邮件中心点击“立即同步并刷新邮件”，验证
回复进入当前 Project 邮件中心且不重复。

## 8. 最终状态

`PASS_WITH_EXTERNAL_ACTION`

代码、本地运行、真实 Gmail API 读取、cursor 持久化、幂等、匹配、重启恢复和邮件中心均已完成；
仅等待当前 Project 的一次用户批准发送和一次真实收件人回复。未执行 Git commit/push，未撤销
现有改动，未发布公网。
