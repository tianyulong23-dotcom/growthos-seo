# Backlinks 推荐后链路运行态收口与安全集成方案 v1

## 1. 文档状态

| 项目 | 值 |
| --- | --- |
| Task ID | `BACKLINKS-POST-RECOMMENDATION-RUNTIME-CLOSURE-001` |
| 状态 | `PLAN_ONLY / NOT_EXECUTED` |
| 日期 | `2026-08-23` |
| 仓库 | `C:\Users\DELL\Documents\缝合\john3947-seo-main` |
| 观察分支 | `main` |
| 观察 HEAD | `2092d0da79cf8b126421369a9ca9db7fd4acd503` |
| 上游方案 | `docs/architecture/backlinks-post-recommendation-flow-optimization-and-coding-plan-v1.md` |
| 当前执行结果 | `backend/core/docs/execution/BACKLINKS-POST-RECOMMENDATION-VALUE-CHAIN-E2E-001-result.md` |
| 本文用途 | 定义 P1-P8 从“代码已实现/已测试”到“真实运行闭环”的安全收口顺序 |
| 本文是否授权实施 | 否 |

本文只是一份实施和验收方案，不授权修改代码、应用 migration、部署服务、调用 Provider、发送邮件、同步 Gmail、运行 Direct Monitor、创建真实业务数据或执行人工审批。

## 2. 执行 Start Card

后续真正开始执行前，执行任务必须先复制并补全下面的 Start Card，未补全不得进入写操作。

| 字段 | 执行要求 |
| --- | --- |
| Task ID | `BACKLINKS-POST-RECOMMENDATION-RUNTIME-CLOSURE-001` |
| 原始用户目标 | 推荐池以后完整打通到 Opportunity、Draft/Mail 或人工合作、Reply、Negotiation、Placement、Direct Monitor、Performance |
| 权威方案 | 本文及上游方案 v1 |
| 唯一结果真相 | 继续维护现有 `BACKLINKS-POST-RECOMMENDATION-VALUE-CHAIN-E2E-001-result.md`，不得另建互相冲突的“完成”报告 |
| 当前阶段 | 必须明确写成 `R0` 至 `R8` 中的一个 |
| 允许文件 | 必须逐文件列出，不允许只写目录或通配符 |
| 共享热点 symbol allowlist | 必须逐符号列出 |
| 数据库写权限 | 默认 `0` |
| Migration apply | 默认 `0` |
| DataForSEO | 默认 `0 requests / USD 0` |
| Gmail send | 默认 `0` |
| Gmail sync | 默认 `0` |
| AI | 默认 `0` |
| Direct Monitor | 默认 `0` |
| Deployment | 默认 `0` |
| Worker 解锁 | 禁止 |
| Refill/request/lease/ledger 创建 | 禁止，除非另有明确 Provider 授权 |
| 手工 SQL | 禁止 |
| Secret 输出 | 禁止 |
| Commit/push/merge | 默认未授权 |
| 退出条件 | 当前阶段的门禁全部满足，或明确停在 `INPUT_REQUIRED` / `BLOCKED` |

## 3. 产品目标与完成定义

### 3.1 目标链路

必须在同一个真实 Website Project、同一个 tenant/RLS 上下文中证明以下链路：

```text
Website Project
  -> Opportunity
  -> Draft
  -> Gmail send intent / manual cooperation
  -> Reply
  -> Negotiation
  -> Placement
  -> Direct Monitor
  -> Performance > Backlinks
```

链路中的关键实体必须具备可追溯的稳定关系：

```text
projectId
  -> opportunityId
  -> sendIntentId 或 manual cooperation action
  -> replyId
  -> negotiation state
  -> placementId
  -> monitor observation
  -> performance projection
```

### 3.2 “打通”的严格含义

以下条件全部满足，才可以称产品链路 `COMPLETE`：

1. P0 推荐池冻结基线和 Recommendation 公开语义保持零 diff。
2. P1-P7 代码门禁、契约门禁、构建门禁和浏览器门禁全部通过。
3. 必需 migration 已通过正式部署流程应用，并有版本和回滚证据。
4. 至少一个真实项目完成端到端 lineage。
5. Gmail 路径或人工合作路径至少有一条完成真实闭环。
6. Reply、Negotiation、Placement 不是 fixture、mock 或手工拼接的数据。
7. Direct Monitor 产生至少一次真实观察，并投影到 Performance > Backlinks。
8. 刷新、项目切换和第二会话后 lineage 仍然一致。
9. 所有证据均为项目级、tenant/RLS scoped。
10. Provider 调用、费用、人工批准、部署和 UAT 分栏记录。

只满足代码、单元测试、契约测试或 fixture 浏览器测试时，只能称 `IMPLEMENTED` 或 `TESTED`，不能称 `COMPLETE`。

## 4. 当前事实基线

根据现有方案、执行结果和当前仓库核对，推荐池后的代码骨架已经基本接通，但运行态、真实 Provider 和真实业务闭环尚未完成。

| 阶段 | 当前代码状态 | 当前测试状态 | Runtime | 真实 Provider | 人工审批 | Deployment | 真实 UAT | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 Project readiness | 已实现 | 已测试 | 有限读取证据 | 不需要 | 未完成真实发布决策 | 未部署验证 | 未完成双项目切换 | `TESTED` |
| P2 Recommendation -> Opportunity | 已实现 | 已测试 | 未证明真实 mutation | `0` | 未完成 | 未部署验证 | 未完成 | `TESTED` |
| P3 Opportunity -> Draft | 已实现 | 已测试 | 未证明真实持久化闭环 | AI `0` | 未完成 | 未部署验证 | 未完成 | `TESTED` |
| P4 Gmail / manual cooperation | 已实现并完成 runtime wiring | 已测试 | 无真实 Gmail 证据 | Gmail `0/0` | 未完成 | 未部署验证 | 未完成 | `TESTED` |
| P5 Reply / Negotiation / Placement | 已实现 | 已测试 | migration 未应用 | Gmail `0` | 未完成 | 未部署验证 | 未完成 | `TESTED` |
| P6 Direct Monitor read model/BFF | 已实现 | 已测试 | 无真实监测观测 | Direct Monitor `0` | 不适用 | 未部署验证 | 未完成 | `TESTED` |
| P7 Performance > Backlinks UI | 已实现 | fixture/代码测试通过 | 未证明生产 API 数据 | `0` | 不适用 | 未部署验证 | 未完成 | `TESTED` |
| P8 真实 lineage | 未执行 | 不适用 | 未执行 | 全部 `0` | 未执行 | `0` | 未执行 | `INPUT_REQUIRED` |

### 4.1 已确认但尚未闭合的事实

1. 当前真实项目 readiness 曾返回 `STALE`，动作是 `REPUBLISH_PROMOTION_TARGET`。
2. 尚无第二个真实项目用于浏览器项目切换和跨项目隔离验收。
3. Opportunity 创建、Draft 生成与编辑目前缺少真实数据库 mutation 证据。
4. Gmail readiness、send intent、reconciliation、reply workbench 已有代码，但真实 send/sync 均为 `0`。
5. 人工合作路径已有状态和动作表达，但没有真实外部沟通及回复闭环证据。
6. Reply、Negotiation、Placement lineage 已有实现，但 migration `0074_backlink_placement_reply_lineage.sql` 尚未正式应用。
7. Direct Monitor 真实调用为 `0`，因此尚无 placed、changed、lost、recovered 等真实观测。
8. Performance > Backlinks 前端已存在，但当前证据主要来自 fixture 和代码测试。
9. 未执行真实部署、生产 smoke、回滚演练或人工 UAT。
10. 现有结果应保持 `INPUT_REQUIRED`，直到 R0-R8 门禁全部满足。

## 5. 强制不变量

### 5.1 Recommendation 冻结区

以下基线必须在每一阶段开始和结束时重新校验：

| 基线 | 值 |
| --- | --- |
| P0 source fingerprint | `11c5c6d0e7aed23a4bcfb28427ac3a068e62103421aeddfa3548cf7609154689` |
| Recommendation semantic closure | `ec0dc3d6aca9bd6fb4d920cfc7b9c1d4cdb886a0b9b755dc4f1eab62af8c129c` |
| P0 path baseline | `94 paths` |

禁止改变：

- Recommendation 生成逻辑
- Recommendation 查询逻辑
- Recommendation command
- 推荐准入规则
- V4 评分
- 发布语义
- 库存语义
- 联系人发现语义
- 推荐池前端行为
- Recommendation OpenAPI 公开契约
- Recommendation 数据语义

如果运行态收口只能通过修改上述冻结区完成，执行任务必须立即停止为 `BLOCKED`，不得放宽冻结测试或绕过 semantic diff。

### 5.2 历史 dirty 归属

当前仓库存在大范围 dirty/untracked 内容。它们全部视为未归属历史改动：

- 不清理。
- 不覆盖。
- 不格式化。
- 不移动。
- 不删除。
- 不默认纳入本任务。
- 不使用 `git add -A`。
- 不使用 `git reset --hard`。
- 不使用 `git checkout --` 清除内容。
- 不通过批量复制目录制造“干净版本”。

任务只允许声明自己实际新建或精确修改的文件，并保存修改前 hash/preimage。

### 5.3 无副作用读取

以下操作必须保持零写入、零 Provider 调用：

- Readiness GET
- 页面刷新
- 项目切换
- 列表、详情和 Performance 查询
- 浏览器返回/前进
- 第二会话重新打开页面
- health/readiness/smoke GET

任何 GET 导致 draft 创建、send intent 创建、monitor request、refill、lease、ledger 或数据库更新时间变化，均为 P0 级阻断。

### 5.4 Tenant/RLS

所有项目级数据库证据必须使用与 Core 运行时等价的 tenant/RLS context。禁止使用未限定的全库 count 代替项目级证据。

表名和 owner 必须由以下四类证据交叉验证：

1. 模型定义。
2. migration。
3. repository/query 代码。
4. 真实数据库元数据。

已知站点资料真实表名是 `platform.site_profiles`，不得误写成 `public.site_profiles`。

## 6. 代码所有权与安全隔离

### 6.1 默认策略

当前 P1-P7 已处于 `TESTED`，因此收口任务的默认动作应是验证和部署，不是继续扩展业务代码。

如果任一门禁发现代码缺陷：

1. 停止当前阶段。
2. 记录最小复现。
3. 创建独立、窄范围的修复任务。
4. 为修复任务指定唯一 owner、逐文件 allowlist、测试和回滚。
5. 修复合入后，从当前阶段的首个门禁重新执行。

不得在真实 UAT 过程中临时修改共享热点。

### 6.2 共享热点

运行时 wiring 的共享热点最多包括：

- `backend/core/src/bootstrap/production-runtime.ts`
- `backend/core/src/http/private-server.ts`
- `backend/core/src/index.ts`，仅在确有导出需要时

每次触及前必须记录：

- 文件 preimage hash。
- 历史 dirty 是否已经存在。
- 允许新增或变更的精确 symbol。
- 变更前后的 AST/语义差异。
- Recommendation semantic diff。

共享热点必须串行接线，同一时间只能有一个 owner。

### 6.3 生成文件

公共契约的唯一合法顺序是：

```text
backend schema/route
  -> contract tests
  -> OpenAPI generation/check
  -> generated client
  -> frontend adapter
  -> UI
```

禁止手工编辑：

```text
frontend/src/api/generated/backlinks.ts
```

如果生成结果包含 Recommendation semantic diff：

1. 不得接受生成结果。
2. 不得通过格式化或快照更新掩盖差异。
3. 必须定位 backend schema/route 的越界变化。
4. 无法在非冻结区修复时，状态为 `BLOCKED`。

### 6.4 前端共享文件的既有 lint 债务

当前共享文件 `frontend/src/features/performance/performance-workspace.tsx` 的文章区域存在两处既有 `react-hooks/set-state-in-effect` lint 错误，观察位置为约第 832、837 行。它们不是 Backlinks 新视图引入的错误。

处理规则：

- Backlinks 收口任务不得顺手修复文章业务代码。
- R0 必须保存准确 lint baseline。
- 若全量 lint 仍只失败于相同既有错误，记录为 `BLOCKED_BY_EXISTING_FRONTEND_OWNER`。
- 由单独任务 `PERFORMANCE-ARTICLE-LINT-OWNER-001` 负责修复，并覆盖文章功能回归测试。
- 该独立修复合入后，Backlinks 发布候选必须重新跑全量 frontend gate。
- 正式发布门禁最终应为零 lint error，不以“没有新增错误”代替生产质量门禁。

## 7. 执行分阶段方案

## R0 集成冻结与任务归属

### 目标

建立可审计的 release candidate 基线，避免将历史 dirty、Recommendation 变化或其他并行任务混入收口。

### 允许动作

- 只读 Git 状态、diff、hash、文件清单。
- 只读现有方案、结果和测试配置。
- 创建任务证据目录和阶段报告，前提是该路径已列入 allowlist。
- 在用户批准后，从明确的集成基线创建专用 `codex/` worktree/branch。

### 必需步骤

1. 保存 `git status --short`、HEAD、branch、tracked diff 和 untracked 清单。
2. 恢复并验证 P0 `94 paths` 基线。
3. 验证 source fingerprint 和 Recommendation semantic closure。
4. 记录共享热点 preimage hash。
5. 建立 task-owned 文件清单。
6. 建立历史 dirty 清单，并声明“不归本任务”。
7. 核对 OpenAPI、generated client 和 frontend adapter 的生成关系。
8. 核对 migration head 和 `0074` 在部署 manifest 中的位置。
9. 运行零 Provider 的现有代码门禁。
10. 输出 R0 checkpoint，不执行 deployment、migration 或 Provider。

### PASS

- P0 两个 hash 与 `94 paths` 均匹配。
- 没有无法归属的任务修改。
- 共享热点 allowlist 可精确到 symbol。
- 所有 Provider、migration、deployment 仍为 `0`。

### BLOCKED

- Recommendation semantic diff 非零。
- 历史 dirty 与任务修改无法区分。
- 只能在冻结区修复。
- migration head 或生成链无法确定。

## R1 零副作用代码与契约总门禁

### 目标

证明 P1-P7 的代码闭环在不接触真实 Provider 和数据库写入的前提下完整、可生成、可构建。

### 后端门禁

```powershell
Set-Location backend/core
npm run verify:backlinks
```

必须覆盖：

- TypeScript typecheck
- lint
- source manifest
- dependencies/license
- OpenAPI
- migration validation
- unit
- API
- contract
- integration
- security
- resilience

### Platform 门禁

使用项目现有 Python runtime/venv 执行：

```powershell
python -m pytest `
  backend/api/tests/test_projects.py `
  backend/api/tests/test_project_authority.py `
  backend/api/tests/test_project_contracts.py `
  backend/api/tests/test_shared_contracts.py `
  backend/api/tests/test_backlinks_project_projection.py `
  backend/api/tests/test_backlinks_gateway.py `
  backend/api/tests/test_database_migration_system.py `
  backend/api/tests/test_performance_api.py
```

### 前端门禁

```powershell
Set-Location frontend
npm run check:backlinks-client
npm run typecheck
npm run lint
npm run test
npm run test:project-authority-source
npm run test:outreach-source
npm run build
```

### 浏览器门禁

```powershell
npm run test:e2e:desktop
npm run test:e2e:mobile
npm run test:e2e:keyboard-a11y
```

浏览器测试必须覆盖：

- 推荐池到 Opportunity 的导航。
- Opportunity 到 Draft。
- Gmail 与 manual cooperation 两种分支的可见状态。
- Reply workbench。
- Negotiation。
- Placement。
- Performance > Backlinks。
- 刷新后状态不丢失。
- 项目切换不串数据。
- 真实生产路由，不允许 fixture fallback 冒充 runtime。

### PASS

- 所有与 Backlinks 相关门禁通过。
- 全量 frontend lint 最终为零错误。
- OpenAPI/generated client 由生成流程产生。
- Recommendation semantic diff 为零。
- GET 零副作用测试通过。

### BLOCKED

- 需要手改 generated client。
- 需要修改 Recommendation 冻结区。
- 发现跨 tenant/project 泄漏。
- 共享前端既有 lint 债务尚未由独立 owner 解决。

## R2 Deployment 与 migration 预检

### 目标

在不应用任何变更的情况下，形成一次可批准的部署包和 migration 执行单。

### 预检内容

1. 确认目标环境、organization、workspace、tenant、project。
2. 确认部署版本、镜像或 artifact digest。
3. 确认 Core、Platform、frontend 的兼容矩阵。
4. 确认正式 migration runner。
5. 确认 `0074_backlink_placement_reply_lineage.sql` 是目标 backlinks head。
6. 在临时数据库验证 fresh install。
7. 在生产结构克隆库验证 upgrade path。
8. 记录 migration 预计锁、耗时、表大小影响。
9. 准备数据库备份和恢复验证。
10. 准备应用与 frontend 回滚 artifact。
11. 准备 deployment health/smoke 查询。
12. 保持真实 migration apply 和 deployment 为 `0`。

### Migration 原则

- 只能通过正式 runner 应用。
- 禁止手工 SQL。
- 禁止临时修改 migration 后直接应用。
- 已发布 migration 不做原地重写。
- 回滚优先使用已验证备份恢复或经过评审的 forward-fix。
- rollback 不得破坏已写入的 reply/placement lineage。

### INPUT_REQUIRED

R2 完成后，必须向用户请求最小授权：

- 目标环境。
- 允许部署的 artifact/digest。
- migration `0074` apply 授权。
- 维护窗口。
- 数据库备份/恢复责任人。
- 回滚决策人。

未获得授权不得进入 R3。

## R3 真实 Project -> Opportunity -> Draft

### 目标

在一个明确的真实项目中，用零付费 Provider 完成推荐后链路的前半段。

### 前置条件

- R0-R2 通过。
- deployment 和 migration 已获授权并成功。
- 指定真实 organization/workspace/tenant/project。
- 项目具备有效 Website Project 配置。
- 指定一个已验收 Recommendation。
- 项目 readiness 的修复动作已由用户批准。

### 步骤

1. 使用 Core 等价 tenant/RLS context 保存项目级 pre-count。
2. GET readiness，证明无数据库写入和 Provider 调用。
3. 若状态为 `STALE`，通过正式发布命令完成 `REPUBLISH_PROMOTION_TARGET`。
4. 再次 GET readiness，证明只发生预期发布变化。
5. 从 Recommendation 执行正式 Opportunity command。
6. 验证幂等键和重复点击不会创建第二条 Opportunity。
7. 刷新页面并用第二会话确认 Opportunity 持久化。
8. 从 Opportunity 创建 Draft。
9. 编辑 Draft，并验证保存、刷新、版本和 stale regeneration 行为。
10. 在第二个真实项目重复只读检查，证明不串项目。

### 证据

- 项目级 pre/post counts。
- command id、opportunityId、draftId。
- tenant/RLS context 的脱敏说明。
- 浏览器截图。
- API trace 中的 request ID，不含 secret。
- Provider requests/cost 仍为 `0`。

### PASS

- Recommendation -> Opportunity -> Draft 的真实 lineage 成立。
- 重复命令幂等。
- 页面刷新和第二会话一致。
- 两个项目隔离。

## R4A Gmail 路径真实 UAT

### 目标

验证 Draft -> SendIntent -> Gmail -> Reply workbench，且每一个外部动作都在明确上限内。

### 最小授权

| 项目 | 建议上限 |
| --- | --- |
| Gmail send | `1` |
| Gmail sync | `1` 次有界同步窗口 |
| 测试收件人 | 用户指定并确认控制权 |
| 邮件正文 | 用户逐字批准 |
| 允许的 Gmail identity | 用户指定 |
| AI | `0`，除非另行批准 |

### 步骤

1. GET Gmail readiness，记录 pre-state，证明零副作用。
2. 使用已批准 Draft 创建不可变 SendIntent。
3. 验证重复提交不产生第二个有效 SendIntent。
4. 在 UI 中显示收件人、主题、正文、发件 identity 和审批状态。
5. 用户人工批准准确正文。
6. 执行一次 Gmail send。
7. 保存 provider message/thread ID 的脱敏证据。
8. 执行一次有界 Gmail sync。
9. 验证 delivered、unknown、duplicate reconciliation。
10. 由受控收件人发送一封真实 reply。
11. 再执行获批的有界 sync，或使用已批准 webhook/runtime 路径。
12. 验证 reply 进入正确 project/opportunity/thread。
13. 验证 ambiguity 不会被静默关联。

### 必须测试的失败状态

- Gmail not ready。
- human approval missing。
- duplicate send。
- delivery unknown。
- provider timeout。
- reply 无法唯一关联。
- reply 属于另一个 project。

### PASS

- 只发送一封已批准邮件。
- SendIntent 不可变且可追溯。
- replyId 精确连接到原 opportunityId。
- Provider 次数和费用不超过授权。

## R4B Manual cooperation 路径真实 UAT

### 目标

验证不依赖 Gmail 的人工合作路径，避免 Gmail 成为所有 Opportunity 的强制门禁。

### 步骤

1. 选择一个适合 manual cooperation 的 Opportunity。
2. 创建人工动作记录，包含渠道、owner、due time 和状态。
3. 不因 Gmail 未就绪而隐藏 Recommendation 或 Opportunity。
4. 人工在外部渠道完成一次受控联系。
5. 只记录必要的脱敏外部 reference，不保存 secret。
6. 收到回复后，通过正式 UI/API 录入 Reply。
7. 验证该 Reply 进入与 Gmail reply 相同的 Negotiation 读模型。
8. 刷新、切换项目和第二会话验证持久化与隔离。

### PASS

- Manual cooperation 可以独立完成到 Reply。
- Gmail readiness 不改变推荐池准入和可见性。
- Reply 后续使用统一的 Negotiation/Placement lineage。

### 完成要求

产品发布前至少 R4A 或 R4B 有一条真实闭环。要宣称两个渠道均已产品化，则两条都必须真实 UAT。

## R5 Reply -> Negotiation -> Placement

### 目标

证明 Reply 经过人工判断和谈判后，形成可监测的 Placement，并保留完整 lineage。

### 步骤

1. 在 Reply workbench 打开真实 reply。
2. 验证 reply 的 projectId、opportunityId、replyId。
3. 录入或更新 Negotiation 状态。
4. 验证 stale version/并发更新被拒绝，而不是覆盖他人修改。
5. 覆盖接受、拒绝、需要补充信息和无效回复。
6. 对达成合作的 reply 创建 Placement。
7. Placement 必须引用准确 replyId 和 opportunityId。
8. 录入 target URL、source URL、anchor、rel、placement status 等正式字段。
9. 刷新、第二会话和项目切换后重新读取。
10. 使用 tenant/RLS scoped SQL/read model 验证 lineage。

### 禁止

- 用手工 SQL 创建 Placement。
- 用 fixture reply 冒充真实回复。
- 通过删除冲突记录解决并发。
- 把无法关联的 reply 自动归到最近 Opportunity。

### PASS

以下关系在 API、数据库读模型和 UI 中完全一致：

```text
projectId == opportunity.projectId
opportunityId == reply.opportunityId
replyId == placement.replyId
placementId == monitor subject lineage
```

## R6 Placement -> Direct Monitor -> Performance

### 目标

证明 Placement 被 Direct Monitor 真实观察，并正确投影到 Performance > Backlinks。

### 最小授权

| 项目 | 建议上限 |
| --- | --- |
| Direct Monitor | `1` 个 placement，首次检查 `1` 次 |
| 后续 reverify | 每次单独批准，或批准一个明确次数和时间窗 |
| DataForSEO | `0` |
| AI | `0` |

### 步骤

1. GET monitor readiness，证明零副作用。
2. 验证 Placement 已满足 monitor 准入条件。
3. 创建一次正式、有账本约束的 monitor request。
4. 记录 request/lease/ledger 的合法创建原因和上限。
5. 执行一次 Direct Monitor。
6. 保存 observation、时间、HTTP 结果、canonical URL、anchor、rel 和状态。
7. 验证 observation 关联正确 placementId。
8. GET Performance > Backlinks。
9. 验证 KPI、状态、最近观察时间和 lineage。
10. 刷新和第二会话复核。

### 状态场景

发布前至少需要：

- `placed/verified` 主路径。
- 一次可控的 reverify。
- 对 changed/lost/provider failure 的代码和契约测试。

如要宣称恢复闭环完整，还需在受控环境验证：

- changed。
- lost。
- recovered。

不得通过修改真实外部网站来制造测试状态。可以使用用户控制的测试页面或明确授权的 sandbox。

### PASS

- Direct Monitor 真实 observation 可追溯到 placementId。
- Performance > Backlinks 无 fixture fallback。
- GET/refresh 不触发 monitor request。
- Provider 次数和费用与授权一致。

## R7 跨会话、跨项目与回放验收

### 目标

证明链路不是一次性页面状态，而是稳定的产品状态。

### 必测场景

1. 浏览器刷新。
2. 登出后重新登录。
3. 第二浏览器会话。
4. 项目 A 切到项目 B，再切回项目 A。
5. 两个用户角色的授权边界。
6. 重复 Opportunity command。
7. 重复 Draft save。
8. 重复 send request。
9. 重复 Gmail sync event。
10. 重复 Reply ingest。
11. Negotiation 并发版本冲突。
12. 重复 Placement confirmation。
13. 重复 monitor observation。
14. Provider timeout 后重放。
15. legacy route 和旧前端入口不回归。

### 核心断言

- 不重复创建业务实体。
- 不跨 project/tenant 读取或更新。
- 不依赖浏览器内存维持 lineage。
- 不用全库 count 作为项目证据。
- 不因 Gmail readiness 改变 Recommendation 可见性。
- 不因 monitoring 状态反向改变 Recommendation 语义。

## R8 最终审计、发布与结论

### 最终审计内容

1. Task-owned 文件清单。
2. 所有文件 preimage/postimage hash。
3. 历史 dirty 未覆盖证明。
4. P0 `94 paths` 基线。
5. source fingerprint。
6. Recommendation semantic closure。
7. OpenAPI semantic diff。
8. generated client 生成记录。
9. migration `0074` apply 记录。
10. deployment artifact/digest。
11. 后端、Platform、frontend、browser 测试结果。
12. runtime smoke。
13. Gmail send/sync 次数与费用。
14. Direct Monitor 次数与费用。
15. DataForSEO 和 AI 次数与费用。
16. human approval 记录。
17. project-scoped lineage。
18. UAT 截图和 request ID。
19. rollback 可执行性。
20. 未解决缺口。

### 状态规则

| 状态 | 定义 |
| --- | --- |
| `IMPLEMENTED` | 代码存在，但未完整测试 |
| `TESTED` | 代码/契约/构建测试通过，但不代表真实 Provider 或真实 UAT |
| `INPUT_REQUIRED` | 需要用户提供环境、项目、授权、人工动作或费用上限 |
| `BLOCKED` | 存在无法在授权边界内解决的技术或归属阻断 |
| `COMPLETE` | R0-R8 全部门禁及真实 lineage/UAT 完成 |

禁止因为 P1-P7 测试通过就把整体结果改为 `COMPLETE`。

## 8. 真实 UAT 场景矩阵

| 场景 | 必需 | 证据 | 未通过时状态 |
| --- | --- | --- | --- |
| Readiness GET 零副作用 | 是 | pre/post counts、Provider 0 | `BLOCKED` |
| STALE 项目正式 republish | 视项目状态 | publish command、version | `INPUT_REQUIRED` 或 `BLOCKED` |
| Recommendation -> Opportunity | 是 | opportunityId、幂等证据 | `BLOCKED` |
| Opportunity -> Draft | 是 | draftId、版本、刷新 | `BLOCKED` |
| Gmail send intent | Gmail 路径必需 | immutable intent | `BLOCKED` |
| 真实 Gmail send | Gmail 路径必需 | provider message/thread ID | `INPUT_REQUIRED` |
| 真实 Gmail reply | Gmail 路径必需 | replyId、thread lineage | `INPUT_REQUIRED` |
| Manual cooperation | 人工路径声明时必需 | action、外部 reference、reply | `INPUT_REQUIRED` |
| Reply ambiguity | 是 | quarantine/人工归属证据 | `BLOCKED` |
| Negotiation 并发 | 是 | stale version rejection | `BLOCKED` |
| Placement lineage | 是 | opportunityId/replyId/placementId | `BLOCKED` |
| Direct Monitor observation | 是 | observation、provider ledger | `INPUT_REQUIRED` |
| Performance projection | 是 | API/UI 一致 | `BLOCKED` |
| 页面刷新 | 是 | 同一实体 ID | `BLOCKED` |
| 第二会话 | 是 | 同一 lineage | `BLOCKED` |
| 项目切换 | 是 | 两个真实项目隔离 | `INPUT_REQUIRED` |
| 部署 smoke | 是 | health、route、asset digest | `INPUT_REQUIRED` |
| 回滚演练 | 是 | rollback artifact/步骤 | `INPUT_REQUIRED` |

## 9. Provider 与费用治理

任何真实调用前，结果文档必须先出现一条用户批准记录：

| 字段 | 要求 |
| --- | --- |
| Provider | Gmail / Direct Monitor / DataForSEO / AI |
| 目的 | 对应 R4/R6 的具体步骤 |
| 最大请求数 | 明确整数 |
| 最大费用 | 明确金额和币种 |
| 目标 project/opportunity/placement | 明确 ID，展示时脱敏 |
| 时间窗 | 明确开始和结束 |
| 允许失败重试 | 明确次数 |
| 人工批准人 | 明确 |
| 停止条件 | 达到上限、错误、歧义或证据已足够 |

默认值始终为：

```text
DataForSEO = 0
Gmail send = 0
Gmail sync = 0
AI = 0
Direct Monitor = 0
Deployment = 0
Migration apply = 0
```

不得把 Provider 凭证、OAuth token、password、完整邮件隐私内容写入日志或结果文档。

## 10. 发布顺序

正式获批后，按以下顺序执行，禁止并行越级：

1. 冻结 release candidate 和任务归属。
2. R1 全量零 Provider 门禁。
3. 数据库备份及恢复验证。
4. 正式应用 migration `0074`。
5. 部署 Core。
6. 执行 Core health 和只读 route smoke。
7. 部署 Platform。
8. 执行 Platform gateway/projection smoke。
9. 部署 frontend。
10. 验证静态资源 digest 和生产路由。
11. 执行零副作用浏览器 smoke。
12. 执行 R3 真实项目链路。
13. 执行获批的 R4A 或 R4B。
14. 执行 R5。
15. 执行获批的 R6。
16. 执行 R7。
17. 完成 R8 审计。

任何步骤失败，都停止后续外部动作，先判断回滚还是 forward-fix。

## 11. 回滚策略

### 应用回滚

- Core、Platform、frontend 均必须有上一个稳定 artifact/digest。
- 回滚不执行数据清理。
- 回滚后先跑只读 health/readiness。
- 不自动重试 Gmail send 或 Direct Monitor。

### 数据库回滚

- 应用 migration 前完成可恢复备份。
- 禁止现场手写 down SQL。
- 如果 migration 已写入真实 lineage，优先 forward-fix。
- 如必须恢复备份，要先评估备份点之后的其他业务写入。
- 回滚决策由明确的数据库责任人批准。

### Provider 回滚

- Gmail 已发送邮件无法技术撤回为“未发送”，因此 SendIntent 和 provider outcome 必须保留。
- delivery unknown 不得自动重发。
- Direct Monitor 失败不得自动无限重试。
- 所有重试使用相同业务幂等键和新的 provider attempt 记录。

## 12. 证据与结果记录

继续使用现有结果文档作为状态真相：

```text
backend/core/docs/execution/
  BACKLINKS-POST-RECOMMENDATION-VALUE-CHAIN-E2E-001-result.md
```

大体积证据可放在执行时批准的独立目录，例如：

```text
output/backlinks-post-recommendation-runtime-closure/<run-id>/
```

每个 checkpoint 至少记录：

- 执行时间。
- branch/HEAD/artifact digest。
- task-owned 文件。
- 测试命令和退出码。
- runtime 环境。
- tenant/project 范围。
- Provider 请求数和费用。
- human approval。
- deployment/migration 状态。
- lineage ID。
- 截图或 trace 索引。
- `IMPLEMENTED` / `TESTED` / `INPUT_REQUIRED` / `BLOCKED` / `COMPLETE`。

结果中必须将以下证据分开：

```text
Code
Contract
Runtime
Real Provider
Human Approval
Deployment
Migration
UAT
```

## 13. 需要用户提供的最小输入

进入真实执行前，需要一次性明确：

1. 目标 environment。
2. organization/workspace/tenant。
3. 至少两个真实 Website Project。
4. 用于主链路的 Recommendation/Opportunity。
5. 是否先走 Gmail、manual cooperation，或两条都验收。
6. Gmail identity 和受控收件人。
7. 邮件正文批准人。
8. Gmail send/sync 上限。
9. Direct Monitor 上限。
10. 是否允许 migration `0074`。
11. 是否允许 deployment。
12. 维护窗口。
13. 数据库备份和回滚责任人。
14. 真实 Placement 或用户控制的测试页面。
15. UAT 操作者和最终签字人。

DataForSEO 和 AI 默认不需要授权；只有实际缺口确实要求时，再单独申请最小上限。

## 14. 最终 Definition of Done

只有以下所有断言为真，才关闭任务：

- [ ] P0 `94 paths` 基线保持。
- [ ] source fingerprint 匹配。
- [ ] Recommendation semantic closure 匹配。
- [ ] 历史 dirty 未清理、覆盖或错误归属。
- [ ] 所有共享热点变更均在 symbol allowlist 内。
- [ ] generated client 仅由生成流程产生。
- [ ] Recommendation OpenAPI semantic diff 为零。
- [ ] backend Core 全门禁通过。
- [ ] Platform focused gate 通过。
- [ ] frontend typecheck/lint/test/build 全通过。
- [ ] desktop/mobile/keyboard-a11y 通过。
- [ ] migration `0074` 正式应用并验证。
- [ ] deployment 和 rollback artifact 可审计。
- [ ] 真实 Project -> Opportunity -> Draft 成立。
- [ ] Gmail 或 manual cooperation 至少一条真实成立。
- [ ] 真实 Reply -> Negotiation -> Placement 成立。
- [ ] Direct Monitor 真实 observation 成立。
- [ ] Performance > Backlinks 展示真实 projection。
- [ ] refresh、第二会话和双项目切换成立。
- [ ] tenant/RLS 隔离成立。
- [ ] GET/readiness 零副作用成立。
- [ ] Provider 次数和费用未超授权。
- [ ] human approval 有记录。
- [ ] 最终结果文档准确区分各证据层。

## 15. 推荐的下一步

下一执行任务只做 `R0`，不直接部署或调用 Provider：

1. 建立专用任务归属和 release candidate。
2. 重新验证 P0 两个 fingerprint 与 `94 paths`。
3. 保存共享热点 preimage/hash 和 symbol allowlist。
4. 运行 R1 的零 Provider 总门禁。
5. 输出准确的 `PASS`、`INPUT_REQUIRED` 或 `BLOCKED`。
6. 只有 R0/R1 通过后，才向用户提交 R2 deployment/migration 授权单。

这样可以把“代码骨架已经存在”和“真实产品链路已经打通”分开，先控制集成风险，再以最小真实调用完成运行态闭环。
