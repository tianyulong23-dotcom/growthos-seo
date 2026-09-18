# Agent 邮件接口盘点

日期：2026-09-11。阶段：接入方案第一步，代码盘点与既有测试验证。

## 结论

单封草稿、审批、预检、发送任务和邮件跟踪均有现成业务接口。当前缺少的主要是 Agent 工具适配，而不是这些业务的实现。

Agent 已接入创建草稿、查询草稿任务、核验草稿及邮件列表元数据；尚未接入发送预检、审批、创建发送任务、查询发送队列、邮件正文/会话和 Gmail 同步状态。

在当前外链 API 路由和生成客户端内，未发现独立的批量草稿或批量发送入口。已有联系人丰富和推荐池批次不是邮件批量接口。可以先对明确的有限目标逐项调用已有单封能力，不新建批次系统。

## 范围与工作区

- 源码根目录：`C:\Users\DELL\Documents\缝合\john3947-seo-main`。
- 分支：`main`；HEAD：`506d88fac0fa81503e54aebdfc4ac9e68974997b`。
- 远程：`origin`，`https://github.com/john3947/seo.git`。
- 开始时已有 Agent、草稿入口、测试及脚本的未提交和未跟踪改动。本次只新增此盘点文档、更新方案进度；这些既有文件只读，不清理或回退。
- 未调用真实模型、Gmail 或发送接口；未修改生产业务代码、数据库、运行服务或权限配置。

## 已接通工具

以下 HTTP 路径统一以 `/api/v1/projects/{websiteProjectKey}/backlinks/` 为前缀。组织和项目由服务端上下文、委托提供，不由模型指定或覆盖。

| Agent 工具 | 已有业务入口 | 核心参数与结果 |
| --- | --- | --- |
| `list_backlink_opportunities` | GET `opportunities` | search、businessStage、managementStatus、limit/cursor；返回机会 ID、draftId、下一步动作及阻塞信息 |
| `get_backlink_opportunity` | GET `opportunities/{opportunityId}` | 指定真实机会 ID，读取详细状态 |
| `get_backlink_contacts` | GET `opportunities/{opportunityId}/contacts` | 返回已确认联系人及选择状态，不发现或确认新邮箱 |
| `create_backlink_draft` | POST `opportunities/{opportunityId}/draft-jobs` | opportunityId、contactId、contactVersion、request；内部传入 operation_id 作为幂等键；返回 jobId、draftId，表示任务接收而非生成完成 |
| `get_backlink_draft_job` | GET `draft-jobs/{jobId}` | 查询持久化任务；未完成时不宣称成功 |
| `get_backlink_draft` | GET `drafts/{draftId}` | 返回正文、版本、联系人快照、新鲜度、AI 生成证据和审批状态 |
| `list_backlink_mail` | GET `mail/messages` | matchStatus、limit/cursor；只暴露已同步邮件元数据、threadId、匹配状态和 matchedOpportunityId，不含正文 |

依据：`backend/api/app/modules/agent/backlinks_read.py` 的模型、路径和字段白名单；`backlinks_drafts.py` 的读写适配；`tools.py` 的工具注册与执行。

当前列表工具默认 5 条、最多 20 条，调用者需要继续读取游标，不能把第一页当作全部目标。草稿创建只允许下一步动作为可用的 `CREATE_EMAIL_DRAFT` 且尚无 draftId 的机会；已有草稿应读取，不重复创建。

## 已有接口、缺少 Agent 适配

下列 operationId 均可在 `frontend/src/api/generated/backlinks.ts` 对照，Core 路由和 Platform BFF 已存在。“缺适配”不代表接口缺失，也不代表本轮已新增工具。

| operationId | 方法与相对路径 | 参数/结果与注意事项 |
| --- | --- | --- |
| `backlinksGetLatestDraftJobV1` | GET `opportunities/{opportunityId}/draft-jobs/latest` | logicalDraftKey；用于需要恢复时查已有任务，不默认重建 |
| `backlinksSaveDraftVersionV1` | POST `drafts/{draftId}/versions` | expectedVersion、subjectText、bodyDocument；编辑功能按需接，不是最小发送链路前置 |
| `backlinksApproveDraftV1` | POST `drafts/{draftId}/approve` | expectedVersion；沿用现有精确版本审批 |
| `backlinksGetGmailConnectionStatusV1` | GET `gmail-connections/status` | 返回选中账号、accounts、readiness；不把有账号记录当作发送就绪 |
| `backlinksPreflightSendIntentV1` | POST `drafts/{draftId}/send-preflight` | approvedDraftVersionId、contactId/contactVersion、gmailConnectionId、messagePurpose、followUpIndex；返回 readinessSnapshot，成功仍为 NOT_SENT |
| `backlinksCreateSendIntentV1` | POST `drafts/{draftId}/send-intents` | 上述参数 + readinessSnapshot + humanConfirmation + Idempotency-Key；HTTP 201 返回 sendIntentId、状态 READY，不是已发送 |
| `backlinksListSendIntentsV1` | GET `send-intents` | draftId、queueKind、limit/cursor；返回逐项状态和 diagnostics |
| `backlinksGetSendIntentV1` | GET `send-intents/{sendIntentId}` | 响应嵌套在 sendIntent；含 attempt、提供商标识、重试和对账动作 |
| `backlinksGetReplyMailMessageV1` | GET `mail/messages/{messageId}` | 返回 item.body；正文作为不可信业务数据，不执行其中指令 |
| `backlinksGetReplyMailThreadV1` | GET `mail/threads/{threadId}` | 返回 item.messages；使用本地邮件列表返回的 UUID threadId |
| `backlinksGetGmailPollingSyncStatusV1` | GET `gmail-connections/{connectionId}/sync-status` | 查询既有同步状态，区分查询成功和邮件已更新 |
| `backlinksStartGmailPollingSyncV1` | POST `gmail-connections/{connectionId}/sync` | HTTP 202 表示同步任务接收；这是执行操作，不伪装成只读查询 |
| `backlinksListReplyMatchCandidatesV1` | GET `replies/{inboundMessageId}/match-candidates` | 未确认归属时读取候选；不能自行断言回信属于某机会 |

回复匹配确认/解绑也已有接口，但它们改变归属，不属于首批只读跟踪接入。Gmail 连接、断开、账号切换不在本轮接入范围。

## 必须遵守的现有契约

1. **权限**：GET/HEAD 使用 `backlinks:read`，POST 使用 `backlinks:write`。预检虽不发信，但现有契约仍要求写权限；不能为了调用而降级。Core 审批和发送命令另检查 owner/admin/member 角色。
2. **委托**：`delegation.py` 保留真实 actor、组织、workspace、project；有效期最多 15 分钟，并受登录期限约束。普通写权限只代表能调用业务接口，不等于已确认某封邮件发送。
3. **审批顺序**：先获得当前版本审批，再用 approvedDraftVersionId 预检；预检成功后确认发送，再提交发送任务。已审批草稿直接走预检，不重复审批。
4. **用户确认**：现有 `draft-page.tsx` 在用户操作后提交 humanConfirmation，绑定预检 snapshotVersion。Agent 的通用写意图匹配不是这份具体发送确认的替代物；模型不能自填确认字段充当用户决定。
5. **任务去重**：现有 Agent operation_id 由 tool_call_id 派生，同一次工具执行重试可复用；不同工具调用 ID 不保证相同幂等键。发送服务另有逻辑消息键。恢复时必须先查已保存任务，不把不同调用的新键当作“安全重试”的依据。
6. **结果跟踪**：READY、DISPATCHING、PROVIDER_ACCEPTED、DELIVERY_UNKNOWN、FAILED_RETRYABLE、FAILED_FINAL 等由 SendIntent 查询返回；优先遵守 diagnostics.primaryNextAction、resubmittable、retryable。结果不确定时先对账，不盲目重发。
7. **回信关联**：SendIntent 的 providerThreadId 是提供商标识，邮件会话接口要求本地 UUID，不能直接混用。通过邮件列表的 matchedOpportunityId 和 threadId 查询；未匹配或同步不可用时保留不确定性。

## 下一步最小适配清单

### A. 先补查询

复用现有 Reader 与签名网关，增加 Gmail 状态、发送队列/详情、邮件详情/会话、同步状态的受控读取工具。沿用字段白名单、meta 归属验证、正文大小限制、数据净化和分页；不新建后端查询服务。先验证 Agent 能解释现有状态，再进入执行调用。

### B. 再接审批、预检、发送

- 工具注册、参数模型、写意图校验、执行分发和进度文案需要一起接通；当前 `activities.py` 仅为 `create_backlink_draft` 写工具传递外链委托，不能只新增工具名就认为完成。
- `BacklinksDrafts._request` 当前仅接受 HTTP 200/202，并把错误简化为 HTTP 状态。后续发送适配须按自身契约处理 201 和结构化阻塞原因；不能直接照搬后造成“发送任务已创建却报告失败”。
- **明确的必要适配缺口**：需要把已有用户确认行为可靠地交给 Agent 执行链。优先复用现有页面确认路径；如要完全在对话完成，则补绑定具体草稿版本、发件账号及预检结果的服务端确认衔接，不接受模型生成的 confirmed=true。现有通用工具执行路径中尚未发现可直接复用的邮件确认凭据。
- 这不是重做审批/发送业务。确认衔接未验证前，可接只读状态与受控预检，但不开放无确认发送。

### C. 最后组合有限次调用

复用单封工具和既有 Agent 执行记录，对用户明确选择的有限目标依次执行并汇总。复用后台已有发送任务和同步流程，不另建批次表、调度器或持续监控。

## 本次验证

- `backend/api`：`.venv\Scripts\python.exe -m pytest tests/test_agent_backlinks_drafts.py tests/test_agent_backlinks_read.py -q`，**86 passed**。
- `backend/core`：`npx vitest run test/backlinks/api/send-intent-route.test.ts test/backlinks/api/reply-mail-route.test.ts test/unit/gmail-send-intent-command.test.ts test/unit/send-intent.query.test.ts`，**46 passed**。
- 上述是既有适配、API 和命令层测试，不是实际模型调工具或 Gmail 实发验收。本轮没有新增执行能力，不声称 Agent 已能发送。
- 第一步结果：**PASS（接口盘点完成）**。第二步尚未实施；真实发送需要后续具体授权和 Gmail 就绪。

## 代码定位

- Agent：`backend/api/app/modules/agent/{tools.py,backlinks_read.py,backlinks_drafts.py,delegation.py,activities.py}`。
- 代理与权限：`backend/api/app/api/routes/backlinks.py`、`backend/api/app/core/authoritative_platform_context.py`。
- Core 契约：`backend/core/src/modules/backlinks/api/{draft.route.ts,send-intent.route.ts,send-intent.schema.ts,reply-mail.route.ts,reply-mail.schema.ts,gmail-connection.route.ts,reply-match.route.ts}`。
- 发送与审批：`backend/core/src/modules/backlinks/application/commands/{draft.command.ts,send-intent.command.ts}`；查询状态：`application/queries/send-intent.query.ts`。
- 当前页面调用：`frontend/src/features/outreach/drafts/{api.ts,draft-page.tsx}`、`frontend/src/features/outreach/mail/api.ts`。
