# Agent 邮件查询接入记录

日期：2026-09-11

## 范围

第二步 A：复用现有 Core 接口，补齐 Agent 查询适配。没有新建邮件业务、队列、批次表或 UI。

工作区：`john3947-seo-main`，分支 `main`，起始 HEAD `506d88fac0fa81503e54aebdfc4ac9e68974997b`。保留现有未提交和未跟踪成果；未提交或推送。

本轮修改范围：Agent `backlinks_read.py`、`model_gateway.py`、`progress.py`；对应只读、草稿安全边界及 activity 测试；本接入记录和方案进度。

## 已接工具

| 工具 | 既有 GET 接口 |
| --- | --- |
| `get_backlink_gmail_status` | `gmail-connections/status` |
| `get_backlink_gmail_sync_status` | `gmail-connections/{connectionId}/sync-status` |
| `list_backlink_send_intents` | `send-intents` |
| `get_backlink_send_intent` | `send-intents/{sendIntentId}` |
| `get_backlink_mail_message` | `mail/messages/{messageId}` |
| `get_backlink_mail_thread` | `mail/threads/{threadId}` |

全部通过现有 Reader、工具注册及 activity 分发；使用持久化运行上下文中的项目、组织及真实用户短期委托。模型不能指定组织、地址、HTTP 方法或确认字段。查询签名只含 `backlinks:read`。

发送列表支持 draftId、queueKind、limit 和 cursor；单页最多 20 项。状态、diagnostics、提供商消息标识原样保留，不推导已送达或已读。DELIVERY_UNKNOWN 不建议盲目重发。

邮件详情读取纯文本及必要地址、匹配归属。HTML 不传给模型，显式返回 htmlAvailable，正文为空不等于邮件为空。邮件内容始终是不可信数据，不作为执行指令或用户授权。沿用脱敏和 48 KB 返回上限；超限明确失败，不静默截断。

邮件详情、会话和发送任务校验返回 ID；会话中的消息必须属于该本地会话。提供商 threadId 不能冒充本地 UUID。Gmail 查询保留阻塞原因、同步时间、失败与重试状态，不触发同步或凭据刷新。

## 验证

执行目录：`backend/api`。

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_agent_backlinks_read.py tests/test_agent_backlinks_drafts.py tests/test_agent_tools.py tests/test_agent_model_gateway.py tests/test_agent_activities.py -q
```

覆盖固定 GET 路径、已签入 Core OpenAPI 参数/返回字段对应关系、只读标记、用户委托传递与拒绝、响应归属与 ID、分页、正文/凭据处理、未知字段过滤、大小限制、八类发送状态、HTTP 失败及既有草稿流程。

结果：**394 passed（21.32 秒）**。`git diff --check` 通过，仅提示工作区既有 LF/CRLF 转换警告。

这些是工具注册/activity/网关模拟与契约回归测试，不是实际模型对话、线上部署或 Gmail 真实发送验收。

## 仍未接入

第二步 B/C 尚未完成：审批、发送预检、发送提交和同步执行工具未开放，也未声称 Agent 已能批量发送。

现有页面的 humanConfirmation 绑定具体版本和预检 snapshot；通用 Agent 写意图不是该确认。当前模型说明引导用户在既有草稿页完成审批和发送确认，之后 Agent 可查询发送记录和回信。

后续只补可信确认与现有执行接口的衔接，不复制审批/发送业务；具体发送授权和 Gmail 就绪仍是实发验收前提。本轮没有真实发送、Gmail 修复、新数据库、部署或推送。
