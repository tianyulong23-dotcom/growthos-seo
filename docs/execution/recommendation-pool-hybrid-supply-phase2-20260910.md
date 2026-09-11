# 推荐池增量接入：阶段2执行记录

日期：2026-09-10。任务：`HYBRID-SUPPLY-PHASE-2`。

## 开工卡

- 依据：`recommendation-pool-hybrid-supply-coding-plan-20260910.md`，仅阶段2。
- 根目录：`C:\Users\DELL\Documents\缝合\john3947-seo-main`。
- Git：main，HEAD `7df8d48d088328bd79fb0a1afef364b17cc8b6af`，origin `https://github.com/john3947/seo.git`。大量既有 dirty/untracked 工作保留。
- 交付：只读匹配、项目 DR GET/项目缓存、V2 准入与必要指标、配置及聚焦测试。
- 停止点：阶段2代码验证与本文；不进入阶段3的分配/解锁/分页，不进入阶段4真实应用验收。
- 真实 Ahrefs/DataForSEO/AI/Gmail 调用上限均为0。禁止业务触发、生产迁移、重启、部署、提交和推送。
- 复用阶段1只读连通/性能及既有独立 Ahrefs GET 证据，不重复预检。
- 验证：fixture SQLite、模拟 HTTP、缓存/供给与 V2 聚焦回归、类型检查、针对性 lint；不跑全库/付费发现。

## 文件所有权与基线

以下路径相对于 `backend/core/src/modules/backlinks`。仅在既有内容上做本阶段必要增量：

| 文件 | 编辑前 SHA256 |
|---|---|
| activities/recommendation-pool-v2.activity.ts | DBF9C3F16ACAA62E69CBED2289D12E83EFD45EB54394E0C31D587DDF76DD8402 |
| runtime/production-runtime.ts | AE76E7C8C1EE9F2490929EF35770D4D5FF96D868A106AC45061F01BDB162B653 |
| ports/secret-store.port.ts | 610F0F991E4A6C9C2EBB9EFA3409B30019B19F5068864C608E1C2E32F616F835 |
| adapters/security/local-product-secret-store-client.ts | AD17E4039D1332E062C8D7ED5845BFABADD75D8173A565DC6D61C0205C5BA413 |
| application/services/recommendation-pool-v2-candidate-admission.service.ts | 7A1381263FCD91233DA0F27671A77A24CF45CD50E5CE169A304FC0640C56D2F5 |
| db/repositories/recommendation-pool-v2-candidate.repository.ts | C59816586A03EF25D7D68DDC5A7E17F6BDB13332221CA40C689A9A74C352CCED |
| domain/recommendations/commercial-discovery-source.ts | 743B4A62AAB1E90C5AF8570C5ED5657F5C3324E5CF147D60B239CCFC304081D7 |

新增范围：Ahrefs HTTP适配器/项目缓存服务与小表、SQLite匹配适配器/端口、hybrid supply服务/仓库/runtime、Ahrefs凭据导入脚本及对应测试。不修改历史迁移、原批次函数、前端或源资源库。

必要追加：`backend/database/deployment-manifest.v1.json` 登记0099前向迁移，编辑前SHA256 `3B9D0684615300DCDC7E68CF9D5CBD4C059CEC771048F75BBD0765D993DED54E`。只修改backlinks head并追加步骤，保留其他未提交变更。

## 检查点

1. 已完成：入口与基线。后台 finalize activity 可复用；不改变 Temporal 指令序列。
2. 已完成：项目缓存、资源匹配及 fixture 验证。
3. 已完成：V2 接线、指标与来源证据验证。
4. 已完成：聚焦回归与阶段2交付；未进入阶段3/4。

## 实现结果

- 只读 SQLite：显式绝对路径、参数化语言/类别/DR筛选、巨型站点和项目全历史排除、canonical 去重均在候选 LIMIT 前。两组低/高DR查询稳定排序，最终选集最多1000，高DR比例以实际库选入数为分母。优先分类采用少量静态别名；无可靠映射标记 UNCONFIRMED。
- 项目 Ahrefs：仅项目域名 GET，解析 `domain_rating.domain_rating`，0有效；不查询候选网站。10秒单次超时，401/403和无效响应不重试，429/5xx/瞬时网络失败最多3次总尝试；错误不携带密钥、响应正文或底层SQL。
- 项目缓存：0099新增项目范围小表，30天成功缓存、10分钟失败缓存，强制RLS。缓存准备与候选事务顺序执行，不嵌套占用连接池；用已有项目上下文行锁串行化缓存未命中。缓存独立提交后重新获取generation锁并核对终态，避免重试重复GET。
- V2接线：在现有 finalize activity 内先准备项目DR，再在原finalize事务里按需匹配和准入；候选与批次原子提交。不新增Temporal activity/工作流，不制造DataForSEO任务或费用。库故障、缺Key、缓存故障保留已有DFS供给；无供给时故障不伪装成耗尽。
- 供给数量只计算首两批缺口及DFS尾批缺口，并受generation剩余容量约束；分批发布仍使用旧finalizer，阶段1的新分配函数尚未启用。不得据此宣称新100条批次分配已完成。
- 库指标保存为 `AHREFS_DR`、`LIBRARY_MONTHLY_TRAFFIC`，provider为 `resource_library`，市场/位置为 GLOBAL；DR不换算Rank，月流量不冒充目标市场自然搜索ETV，缺失保留null。语言/分类/相关性保存在来源证据中。
- 库来源不再自动赋予 VERIFIED_SOURCE_RELATION / COOPERATION_PATH；只在明确类别匹配时记录类别相关证据。未知类别仍可准入但不伪装为已确认相关。联系人、Opportunity、草稿和发送流程未修改。

## 验证结果

最终不同测试共21个文件、174项通过，不把重复运行相加：

| 验证组 | 文件 / 测试 | 结果 |
|---|---|---|
| 新增适配器、缓存、供给、接线、库指标、secret，以及现有准入/工作流/联系人准备/批次/解锁/feed回归 | 18 / 161 | PASS |
| 新0099缓存表与真实仓库：隔离PostgreSQL，DR=0、失败null、跨项目RLS、非法数值/时限、删除权限 | 1 / 8 | PASS |
| 现有完整部署清单：新建、升级与冻结保护 | 1 / 4 | PASS |
| Temporal录制历史重放，成功与失败各一份历史 | 1 / 1 | PASS |

- `npm run typecheck`：PASS。
- 所有本阶段TS文件的针对性 ESLint：PASS。
- `npm run migration:backlinks:check`：PASS，91个迁移文件，head 0099。
- 已编辑的既有文件 `git diff --check`：PASS，仅原仓库LF/CRLF提示，无空白错误。
- SQLite测试含50,000行fixture，真实执行新适配器查询，选出1000条且低于2000ms测试预算；不是生产并发SLA。源库实际规模/连通/原查询耗时复用阶段1证据，本阶段未再次扫描原库。
- 缓存表测试首次容器连接超时；固定测试连接IPv4后通过。完整部署测试曾两次在连接阶段ECONNRESET，使用进程环境 `NODE_OPTIONS=--dns-result-order=ipv4first` 后4项通过；没有修改业务服务或共享测试harness。
- `node:sqlite`在当前Node 24运行时仍输出experimental提示，当前Windows后台可用性沿用阶段1；不声称任意Node版本/云容器均适用。

## 启用配置与未执行事项

这是 IMPLEMENTED + TESTED，不是 LOCAL_RUNTIME / REAL_PROVIDER / DEPLOYMENT / HUMAN_UAT 完成。

启用时需要按正常部署流程应用0099，并为后台worker配置：

| 配置 | 用途 |
|---|---|
| `RESOURCE_LIBRARY_SQLITE_PATH` | worker能读取的源库绝对路径；未配置时不启用新供给，保留原行为 |
| `PLATFORM_SECRET_STORE_ROOT` | 沿用现有服务端secret store根目录 |
| `AHREFS_CREDENTIAL_SECRET_REF` | `secret://growthos/local-product/ahrefs/provider-credential/v1` |

新增 `backend/core/scripts/import-local-product-ahrefs-credential.ts` 只从stdin接收 `{apiKey: ...}` 并写入上述既有加密secret store，不发GET、不更新manifest、不重启。部署时使用用户已准备的新Key；本阶段没有读取/导入DPAPI暂存或真实密钥，不要求用户重新提供Key。容器需显式只读挂载并配置容器内路径，不能直接套用Windows路径。

源库数据仍留在原项目。没有把约5万条库数据导入GrowthOS；运行时只写本轮选中且通过V2准入的候选。由于本阶段未触发业务任务，本任务写入的业务库候选数为0。

未执行：真实Ahrefs/DataForSEO/AI/Gmail调用、生产迁移、业务生成、运行时重启、部署、提交/推送。现有独立项目GET证据不等同于新应用链路已实测。Ahrefs商用许可及源库数据使用授权仍需在商用启用前确认。

下一阶段只处理已授权方案里的新旧分配兼容、最多100条批次、去时间/数量解锁门槛、35条分页及指标GET投影；完整“应用密钥 -> 项目DR保存 -> 库匹配 -> 发布/GET”验收留阶段4。本阶段在此停止。
