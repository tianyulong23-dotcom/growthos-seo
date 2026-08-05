# LOCAL-REAL-005 AI 草稿与 Gmail 发送

- 执行日期：`2026-08-04`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-REAL-005`
- 状态：`PASS_WITH_EXTERNAL_ACTION`
- 当前 Website Project：`elephtv`
- 最终运行 ID：`20260804-224920`
- 唯一人工操作入口：`http://localhost:5173/projects/elephtv/backlinks/drafts/8fce0822-4ef9-4010-b6a5-6f57308698dc`

## 1. 结论

当前真实 ElephTV Website Project 已完成以下本地业务链路：

```text
真实 Opportunity
-> 已确认公开联系人
-> 真实 AI Provider 生成结构化草稿
-> Evidence Snapshot / ModelRun / DraftVersion 持久化
-> 前端读取真实 MODEL 草稿
-> 等待用户编辑、批准并点击发送
```

Gmail 账号已连接且发送能力可用，本轮没有自动发送邮件。剩余动作仅是用户在审核页确认
真实收件人和内容，然后执行批准与发送；该动作不能由自动验证代替。

## 2. 本轮实现

### 2.1 本地 Provider 与运行门禁

- 合法 Secret Reference 按 scheme、root 和 secret kind 校验，不再依赖旧的固定 Secret 名称。
- 启动参数可显式启用 AI、Gmail Send、Gmail Sync 和共享 Browser Worker。
- Provider 配置完整时，启动脚本自动打开当前 Project 的数据库 Kill Switch。
- AI 最大调用数、输入/输出 token、费用预算、Gmail 24 小时发送上限和最小发送间隔均可配置且有上限。
- 最终配置为 AI 最多 `25` 次、Gmail 最多 `20` 封/24 小时、最小间隔 `120` 秒。
- `DATAFORSEO_ENABLED=false`，005 不依赖 DataForSEO。
- 未引入 canary allowlist、approvedBy、authorization window、publicBaseUrl、Tunnel、gcloud 或第二套 Worker/Queue。

### 2.2 Gmail OAuth 复用

- localhost callback 按当前真实 Project key `elephtv` 动态生成。
- 复用同 organization 下已连接 Gmail 账号，并为当前 workspace 建立数据库绑定。
- 当前连接账号为 `tianyulong23@gmail.com`，状态为 `CONNECTED`，发送能力为 `AVAILABLE`。
- scope 包含 `gmail.send` 和 `gmail.readonly`。
- access/refresh token 继续只保存在外部 Secret Store；数据库仅保存 Secret Reference 和连接元数据。
- 本轮不需要重新创建 OAuth Client、manifest、canary Project 或公网域名。

### 2.3 联系人、草稿与发送边界

- Opportunity `fe475ba8-3360-43f8-a04e-ec4706f11afd` 使用已确认公开联系人
  `jane@weekendspecial.co.za`，用途为 `editorial`，置信度 `90`。
- 安全公开联系人可进入草稿链路；低置信、unknown purpose 或其他高风险联系人继续保留
  `contactReviewRequired=true`，不能静默替代当前联系人。
- Prompt 使用当前 Project 产品、市场、关键词、目标 URL、Recommendation、公开页面和联系人用途。
- 结构化结果持久化 `subject`、`body`、claims、risk flags、`evidenceRefs` 和完整 evidence snapshot。
- Evidence Snapshot 中邮箱已脱敏，模型输出不能虚构价格、承诺、身份或无来源事实。
- 当前草稿始终要求用户确认，`canAutoSend=false`。
- 用户点击批准后才写入批准审计；用户点击发送即本次发送批准，不再要求额外 manifest 或批准人。
- 现有 suppression、unsubscribe、重复发送、滚动额度、最小间隔、idempotency 和
  `acceptance_unknown` 保护保持生效。

## 3. 真实运行证据

| 项目 | 结果 |
| --- | --- |
| AI job / run | `e200961d-1277-49df-957a-68e1c1e7627a`，`SUCCEEDED` |
| Draft | `8fce0822-4ef9-4010-b6a5-6f57308698dc` |
| Final DraftVersion | `4b5f4129-ae0e-4830-ae9b-99f48f5880c8`，version `2` |
| Provider / model | `openai` / `gpt-5.6-sol` / `2026-08-03` |
| Generation mode | `MODEL`，无 template fallback |
| Token / latency | input `6649`，output `516`，`18936 ms` |
| Estimated cost | final call `USD 0.000974`；本轮两次成功调用合计 `USD 0.001835` |
| Evidence Snapshot | `9b8044f2-d480-49cb-a85d-e0f0b7980581`，`5` 项 |
| Evidence refs | `contact:confirmed`、`profile:current`、`promotion-target:current`、`target-public-content:contact` |
| Draft state | `draft`，source `MODEL`，`requiresUserConfirmation=true` |

第一次真实模型运行暴露了持久化结构缺少顶层 `evidenceRefs`，修复后第二次真实调用确认
`evidenceRefs` 与 claims 使用的 evidence IDs 一致。Core 重启后仍能读取相同 Draft 和 MODEL
版本，证明不是进程内临时结果。

## 4. UI 与持久化边界

真实浏览器已打开上述审核页，验证：

- 页面显示“草稿编辑”和“待审批”；
- 显示真实 MODEL 来源、后端版本、主题和正文；
- “人工批准”可见，未出现自动发送入口；
- 浏览器控制台 `0` 个 error、`0` 个 warning。

本轮已持久化 Contact、EvidenceSnapshot、EmailDraft、ModelRun、DraftVersion、provider usage
和质量元数据。由于尚未由用户批准和发送，批准审计、SendIntent、SendAttempt、Message 和
ProviderEvidence 尚未创建；这是预期的外部动作边界，不是代码阻碍。

## 5. 验证结果

- 改动相关测试：`9` 个文件、`71` 个测试通过。
- Draft migration/integration：`8/8` 通过。
- Opportunity integration：`1/1` 通过。
- 本地启动脚本测试：`9/9` 通过。
- Core TypeScript typecheck：通过。
- Core production build：通过。
- `git diff --check`：无 whitespace error。
- 按 V1.1 要求，本轮未执行全仓库综合 Gate。

## 6. 最终运行状态

- Frontend `5173`、Gateway `7200`、Core `7301`、Browser Worker `7401` 均监听。
- PostgreSQL `55432` healthy，migration head `0039`。
- Temporal `57233` healthy。
- AI、Gmail Send、Gmail Sync、Browser 的当前 Project Kill Switch 均为开放状态。
- Gmail 已连接，本轮未暴露 token、authorization code、PKCE 或其他凭据。

## 7. 剩余外部动作

打开唯一人工操作入口，核对或编辑收件人、主题和正文，点击“人工批准”，再由用户点击发送。
系统不得代替该动作自动发送。

## 8. 最终状态

`PASS_WITH_EXTERNAL_ACTION`

代码、本地运行、真实 AI 草稿、Gmail 连接和审核 UI 均已完成；仅等待一次用户控制的批准与
真实发送。未执行 Git commit/push，未撤销现有改动，未发布公网。
