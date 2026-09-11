# 推荐池增量接入：阶段1执行记录

日期：2026-09-10（Asia/Shanghai）

## 开工卡

- 任务：`HYBRID-SUPPLY-PHASE-1`，仅执行方案阶段1。
- 依据：`docs/execution/recommendation-pool-hybrid-supply-coding-plan-20260910.md`。
- 交付：本文、未接线的纯批次分配函数及聚焦测试。阶段2以前停止。
- 禁止：真实 Ahrefs/DataForSEO/AI/Gmail 请求、业务任务触发、迁移、重启、提交或推送。
- 唯一源码根：`C:\Users\DELL\Documents\缝合\john3947-seo-main`。
- Git：`main`，HEAD `7df8d48d088328bd79fb0a1afef364b17cc8b6af`，origin `https://github.com/john3947/seo.git`。
- 工作区已有大量修改及未跟踪 V2 文件，均视为既有工作；本任务不清理、不覆盖。

## 本任务文件所有权

本阶段只编辑以下三个文件；其他接入口仅阅读。

| 文件 | 开始状态与基线 SHA256 | 本任务范围 |
|---|---|---|
| `backend/core/src/modules/backlinks/domain/recommendations/recommendation-batch-policy.ts` | 已存在、未跟踪；`2B80B5BEAA6564F242341EB93BBF5F70099D13EAFA572266B180B1885FF1B5D3` | 仅追加纯分配函数，不改旧函数或指纹 |
| `backend/core/test/unit/recommendation-hybrid-batch-allocation.test.ts` | 新文件 | 新规则分配和旧策略兼容测试 |
| 本文 | 新文件 | 阶段1证据、后续最小接入范围与停止点 |

原方案 SHA256：`0FAD6ADAD91DA123037F116E91FF30438DFCA0D676E9AA9A91804BF639912827`。不改原方案。
原批次测试 SHA256：`0EEC3E1ACCAFD66D886810390755520A1CA1D8C98AE07C5D944A9B5C9F89B0D0`。不改原测试。

## 检查点

1. 已完成：Git 边界与 batch/release/feed 基线，7 个文件、39 项测试通过。
2. 已完成：Worker 同二进制、同账户的只读 SQLite 查询与有界性能检查。
3. 已完成：200/120/50/0/奇数/450 分配测试，旧策略兼容断言。
4. 已完成：锁定后续最小接入口、最终聚焦验证。停止在阶段1。

## 只读库与 Worker 环境

- 当前 Worker：Windows 本机进程 PID 29504，`127.0.0.1:7302`，命令 `dist/index.js worker`。健康接口返回 normal、businessConsumersRunning=true、Postgres/Temporal 可用，构建标识 `local-product-1f8a49f9bdd1a16d8391fc17`。
- 可执行文件 `C:\Program Files\nodejs\node.exe`，Node 24.14.1；进程账户及探测账户均为 `DESKTOP-C9194QL\DELL`。
- 使用同一二进制及账户启动独立只读探测，不向运行中的 Worker 注入代码，不触发业务工作流。此证据证明本机读取条件成立，不等于应用适配器已接线。
- 数据库：`C:\Users\DELL\Documents\ChatGPT\爬取外链资源\data\icopify-39023\publishers.sqlite`，11,128,832 字节，49,742 条记录、49,737 个 distinct domain；缺失 DR 305 条，DR=0 有3,779条，二者不能混同。
- 驱动：内置 `node:sqlite`，SQLite 3.51.2，`new DatabaseSync(path, { readOnly: true, timeout: 2000 })`。只执行 SELECT/只读 PRAGMA，无安装依赖、无库写入。
- SHA256：`bbe2265b4e3e05810ef2c62fdc0ee5b584b55a8d6baff9cd876be094fe62e06b`。探测前后哈希和修改时间一致，journal_mode=delete。
- 可用字段：domain、website_url、categories_json、monthly_traffic、ahrefs_dr、moz_da、language、price/currency、max_links、link_type、turnaround 等。
- 指标索引 `publishers_metrics_idx(ahrefs_dr, moz_da, monthly_traffic)`，非空域名有部分唯一索引。

参数化查询顺序：非空域名、语言、DR 区间、`json_each(categories_json)` 分类匹配、参数化项目历史域名排除，全部在 LIMIT 前；稳定排序为 DR 降序、monthly_traffic 降序、domain 升序。每组连续5次，本机样本结果如下（不代表生产并发 SLA）：

| 分类 / 语言 | DR 区间 | 上限 | 命中 | 单次耗时范围 |
|---|---|---:|---:|---:|
| Home and Family / English | [40,60) | 1000 | 230 | 31.29–44.30ms |
| Home and Family / English | [60,101) | 1000 | 53 | 10.62–11.96ms |
| Technology / English | [40,101) | 1000 | 1000 | 20.69–22.90ms |
| Home and Family / English | [40,60) | 100 | 100 | 15.64–18.57ms |

5次返回顺序一致，DR 条件均成立；将返回域名作为下一次排除参数后没有重叠。EXPLAIN 使用指标索引，排序后两项使用临时 B-tree。此处只验证 SQL 排除能力，尚未接入项目全历史数据。

风险边界：该 Node 版本仍对 SQLite 发出 ExperimentalWarning；同步查询必须保持有界，阶段2再验证实际业务适配器与错误路径。当前不是容器 Worker，未验证容器只读挂载、云端路径或生产并发。库不能访问时应明确失败，不绕过为写入模式或伪造空库成功。

## 分配与持久化结论

新增 `planRecommendationHybridBatchAllocation` 仅接受一个 generation 内已经合格、去重、合计不超过1000的两类候选数量，返回全部批次的数量分配，不读取数据库、分配具体域名或发布候选。

- 首两批按 `min(DataForSEO,200)` 向上/向下均分，各自用库候选补至最多100。
- 第三批起仍优先消耗 DataForSEO；450+50 返回100/100/100/100/(50+50)，不强制第三批转库。
- 库不足允许小批次，不产生空批次；两类供给总量守恒。
- 此函数尚无生产调用者，不替换原五等分函数或 v1 指纹。
- 它计算完整快照，不能在每次刷新时拿“剩余数量”重新调用并当作首两批；确定性单测不等于数据库幂等验证。

现有字段足以保存最终分配：generation、canonical release batch 的 `batch_ordinal`、`original_batch_size`、`selection_policy_version`、`order_fingerprint`、batch item 的成员关系，以及用户 cursor 的 `highest_published_batch_ordinal/current_batch_id`。`finalizeGeneration` 已锁 generation 行，已完成时读取既有结果；用户发布另有 cursor 行锁。

后续最小做法：在新 generation 完成合格供给后，一次事务持久化全部 canonical 批次及具体成员，用新的选择策略版本区分新分配；重试读取已持久化结果。沿用用户发布事实判断已发布批次，不拿发现 `roundNumber` 当用户批次，不修改旧批次或历史指纹。不需要新建预留队列或持久游标平台。阶段3须补数据库重试/并发回归，阶段1没有证明该接线已完成。

## 后续最小接入口

以下是已阅读源码后锁定的接入范围，不是本阶段已修改的内容。路径以 `backend/core/src/modules/backlinks` 为基准：

| 范围 | 现有接入口及必要改动 |
|---|---|
| 只读资源匹配 | 新增小型 SQLite 适配器与必要端口/配置，在现有 V2 供给生命周期接入；保留原库、按需要准入，不先导入整个库 |
| 候选准入 | `application/services/recommendation-pool-v2-candidate-admission.service.ts` 与 candidate repository；复用项目历史去重、巨站排除、generation 余量；修正 `CURATED_RESOURCE_LIBRARY` 默认赋予合作证据的分支 |
| 指标 | candidate repository 当前类型只有 ETV/rank/spam；0091 指标表使用非空文本 metric_type，可保存明确来源指标，TypeScript/投影仍需必要扩展；不能把库流量映射为 ETV、把 DR 映射为 DataForSEO rank |
| 项目 DR / 缓存 | 现有 backlink-profile service/schema/runtime 及必要持久化；0050 profile artifact 约束限定 DataForSEO，不可直接塞 Ahrefs。阶段2做最小字段/约束扩展或专用小表，不复用不相容报表聚合表；未知 DR 保持未知 |
| Ahrefs 凭据 | `ports/secret-store.port.ts`、`adapters/security/local-product-secret-store-client.ts` 及对应配置/导入入口，扩展既有 secret store，不新增 DPAPI 运行依赖；本轮不重复真实 Ahrefs 验证 |
| 批次 | 本纯函数、`application/services/recommendation-pool-generation-finalizer.service.ts`、`db/repositories/recommendation-pool-v2.repository.ts`；新策略版本仅用于新供给，保留24小时联系准备 |
| 解锁/容量 | user unlock policy、release command 和 `db/repositories/recommendation-user-release.repository.ts`；repository 也有 `NOT_UNLOCKED` 判断，不能只改服务层 |
| 分页/展示 | feed query/schema/repository/API 及必要 gateway/client；`frontend/src/features/outreach/recommendations/recommendation-feed-workspace.tsx` 初始和重置均为25，后续一并改35，保留筛选先于分页、联系方式优先排序 |

沿用现有 workflow/activity 边界，优先在已有 activity 的服务实现内接入，不新增一套发现流程；如后续确需改变 Temporal 指令序列，必须单独处理重放兼容。

## 验证记录与交付边界

工作目录 `backend/core`：

1. 原基线：7文件、39项通过，涵盖 batch、unlock、release command、feed query/repository 和 feed/release API。
2. RED：先新增24项测试，新增函数尚不存在时16项失败、8项通过；错误为 `planRecommendationHybridBatchAllocation is not a function`。其中非法输入测试此时会因缺失函数的 TypeError 通过，不把它算作新逻辑验证。
3. GREEN：追加纯函数后，以上7文件加新测试共8文件、63项通过。包含200/120/50/0、奇数、450、库不足、空供给、非法输入，以及0至1000各 DataForSEO 数量配合多个库数量的守恒/容量断言。
4. `npm run typecheck` 通过。
5. 针对本次两个 TypeScript 文件的 `npx eslint` 通过。
6. 旧策略文件追加部分以前的原始字节 SHA256 与开工值一致；原测试和原方案 SHA256 亦一致。旧排序/批次指纹 golden 测试通过。

聚焦测试命令：

```powershell
npx vitest run test/unit/recommendation-hybrid-batch-allocation.test.ts test/unit/recommendation-batch-policy.test.ts test/unit/recommendation-user-unlock-policy.test.ts test/unit/recommendation-user-release-command.test.ts test/unit/recommendation-feed-query.test.ts test/unit/recommendation-feed-repository.test.ts test/backlinks/api/recommendation-feed-route.test.ts test/backlinks/api/recommendation-user-release-route.test.ts
```

结论：**阶段1 PASS**。已实现/测试的是未接线的纯分配规则；本机只读连通和查询性能已有实测。未实施阶段2及以后：没有数据库迁移、真实 provider 调用、真实发送、服务重启、部署、提交或推送；没有声明混合推荐 UI、数据库分配重试或真实用户端到端验收通过。下一步须由用户另行启动阶段2。
