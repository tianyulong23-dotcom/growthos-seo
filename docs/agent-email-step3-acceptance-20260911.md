# Agent 邮件第三步验收

日期：2026-09-11。依据：`agent-email-batch-plan-20260911.md` 第三步。

## 边界与所有权

- 范围：已接通工具的调用、权限、失败语义及 ElephTV 只读对话对照。
- 停止点：完成验收报告；不跨入审批/发送适配开发。
- 允许修改：本报告、必要的聚焦回归测试及 `.runtime` 隔离验收脚本；如发现产品缺陷，先定位最小修改范围。
- 保留当前 dirty work。源码根目录 `john3947-seo-main`，`main`，HEAD `506d88fac0fa81503e54aebdfc4ac9e68974997b`，origin `https://github.com/john3947/seo.git`。
- 真实模型：最多一条只读对话、8 个模型轮次，沿用隔离验收环境的 0.50 USD 账面预算与 240 秒超时。模型价格未核实，不能将账面预算或零记账当作真实计费保证。失败不盲目重试。
- Gmail、DataForSEO、草稿生成、审批、发送、同步和业务数据写入：零；仅允许新增本次 Agent 对话/运行记录。
- 不重启共享 UI/API/Core，不提交、不推送。

## 检查点

1. 环境和所有权核对。
2. 工具与已有业务服务的聚焦回归。
3. 本地只读对话与页面/API 对照。
4. 记录覆盖缺口，检查终态并清理自建进程。

## 初始限制

第二步仅完成查询适配。审批、预检、发送及同步执行未接入 Agent；本轮不能把 Core 单独测试通过计为 Agent 发送或批量发送通过。

## 结果

总体：PARTIAL / BLOCKED，不宣称完整第三步或邮件执行全流程通过。

- TESTED：API 聚焦回归修改前 394 通过，补充两个提示约束测试后 396 通过；覆盖只读、草稿、注册、模型网关和委托活动。
- TESTED：Core 发送路由、邮件路由、发送命令与查询四个测试文件共 46 通过。这是业务服务回归，不是 Agent 发送验收。
- LOCAL_RUNTIME：在独立 API 7211、UI 5183 和专用 Agent 队列中，通过浏览器提交一条 ElephTV 只读对话，运行正常结束。
- REAL_PROVIDER：调用真实模型；5 次决策调用、1 次历史压缩，记录 token 合计 60,104（含输入、输出及压缩，非实际费用）。16 次业务工具读取，其中 8 次为重复读取。没有第二条模型验收请求。
- 页面/API 对照：3 封草稿均为 MODEL / AI_DRAFT_READY、FRESH、未审批；发送记录 0、已保存邮件 0，列表没有下一页。Agent 正确区分“无已保存回信证据”和“确定没有回信”。
- Gmail 连接为 CONNECTED，但发送 ready=false / WAITING_FOR_SEND_CONTEXT，需要具体草稿及收件人预检。同步状态 WAITING_FOR_ACCEPTED_SEND，killSwitchOpen=true；页面显示“邮件同步已暂停”。
- 当前项目没有已保存邮件、会话或发送任务详情样本，因此这些详情工具仅有自动测试证据，未取得真实样本验收证据。

命令：

```text
backend/api:
.\.venv\Scripts\python.exe -m pytest tests/test_agent_backlinks_read.py tests/test_agent_backlinks_drafts.py tests/test_agent_tools.py tests/test_agent_model_gateway.py tests/test_agent_activities.py -q

backend/core:
npx vitest run test/backlinks/api/send-intent-route.test.ts test/backlinks/api/reply-mail-route.test.ts test/unit/gmail-send-intent-command.test.ts test/unit/send-intent.query.test.ts
```

模型运行证据：

- conversationId: e005a29d-b792-4147-8987-a6b41c0491b4
- runId: 3a52a9a0-2574-408a-9e11-d50f351895e5
- 终态：completed；全部工具步骤 completed，无工具错误。
- 业务工具仅 Gmail 状态/同步状态、机会、草稿、邮件及发送意图查询；查询适配来源均为 GET，草稿读取方法亦复用 GET，没有生成或发送工具调用。

## 验收发现与最小修补

1. Agent 漏报 killSwitchOpen=true 的同步暂停状态；“发送能力可用”的表述也可能混淆账号连接与具体邮件发送就绪。
2. 最后一次同步查询时间为 2026-09-11T10:15:22Z，回答却引用较早结果 10:14:21Z。
3. 重复查询同一组数据，增加上下文和压缩开销。

仅在 model_gateway.py 的邮件调用说明中补充：暂停优先报告、连接不等于发送就绪、采用最新返回证据、复用本轮成功读取、满足查询后直接回答。补充两个提示契约测试，无业务接口或状态机改动。

该修补只有 TESTED 证据，没有再次消耗模型额度实测；不能将提示测试等同于模型行为已修复。修改前上述问题已在真实模型与页面/API 对照中复现。后续同类对话须复验这三项。

## 尚未完成

- Agent 审批/预检/提交发送适配缺失，因此发送顺序模拟、批量发送部分失败/重试/超时恢复尚不能验收。
- 本次未新增草稿，单封生成链路仅有聚焦自动测试，不是本轮真实生成验收；没有完整有限批量执行证据。
- 不绕过现有页面的人为发送确认，不新建批次数据库、队列或另一套邮件业务。
- 下一实施点仍是第二步剩余的薄适配及确认衔接；完成后再补第三步发送模拟和有限清单恢复测试，最后才考虑另行授权的真实发送。

## 清理与交付边界

- 本轮隔离浏览器页已关闭；自建 API、Agent worker、Vite 进程已按 PID、命令行及创建时间核对后关闭，7211/5183 不再监听。
- 共享 5173/7200/7301/7302/7233 的监听 PID 与启动前一致，没有重启共享服务。
- 没有由本任务发起 Gmail 同步、修改配置或发送邮件；共享后台可能自行更新同步时间，不把这类变化归因于本任务。
- 无部署、共享运行时更新、提交或推送；保留原有未提交改动。本轮只新增报告并修改上述提示和两个测试。
