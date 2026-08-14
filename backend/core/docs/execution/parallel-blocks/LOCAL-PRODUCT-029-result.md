# LOCAL-PRODUCT-029 项目级智能发现蓝图与竞争对手隔离结果

- 执行日期：`2026-08-10`（星期一）
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-029`
- 最终状态：`PASS`
- Stop boundary：未执行 `LOCAL-PRODUCT-030..033`

## 1. 结论

项目级智能发现蓝图已改为只读取当前 Website Project 的 Context 和版本化项目
设置。生产代码不再把全局 `DATAFORSEO_DISCOVERY_TARGETS_JSON` 当作所有项目的
显式竞争对手，也没有针对 Aiper、AWOL、ElephTV 或任意行业增加域名特判。

ElephTV 的 `showmax.com` 只存在于 ElephTV 自己的新设置版本中；Aiper 和 AWOL
的最新项目设置仍为空数组。旧设置版本和旧 Blueprint 均保留，没有原地覆盖。

本轮沿用现有 FastAPI Gateway、私有 Backlinks Core、PostgreSQL、Temporal、
单一 Worker、现有 DataForSEO Provider 与现有 AI Provider 配置，没有创建第二套
Provider、Queue、Worker、Crawler、Browser Launcher、数据库或业务状态机。
Recommendation 到 Opportunity 的人工确认边界未改变。

## 2. 实现结果

### 2.1 项目级输入和设置

- 项目设置新增并校验以下可选数组，缺省值均为 `[]`：
  - `targetAudiences`
  - `partnershipGoals`
  - `discoveryExplicitCompetitorDomains`
- Blueprint 输入只来自当前项目：
  - canonical domain
  - country / language
  - products / keywords
  - promotion target pages
  - target audiences / partnership goals
  - project explicit competitors
- 旧设置记录缺少新字段时，由 API/runtime 兼容层补为空数组，不改写历史行。

### 2.2 来源顺序与验证

发现来源按以下固定顺序组合并稳定去重：

1. `PROJECT_EXPLICIT_COMPETITORS`
2. `DATAFORSEO_CURRENT_DOMAIN_COMPETITORS`
3. `PROJECT_MARKET_SERP`
4. `INDUSTRY_EDITORIAL_ECOSYSTEM`

AI 建议的竞争对手被视为未验证建议。进入已验证种子前必须完成域名规范化、
当前项目排除，并获得 DataForSEO 观察证据或允许的静态证据。候选组合过程不会
从其他 Website Project 读取域名、关键词、市场或历史候选。

### 2.3 AI 与 deterministic fallback

- AI Runtime 可用时使用现有 AI Provider 配置执行一次结构化 Blueprint 调用。
- 输出必须通过严格 Schema 校验；不使用工具调用、自动修复或隐式重试。
- AI 不可用时生成只依赖当前项目事实的 deterministic fallback。
- fallback 覆盖媒体、博客、资源页、评测站和合作伙伴生态，且关键来源数组不为空。
- Blueprint 按 `project_context_version_id + blueprint_version` 持久化和复用。
- 同一 Context 使用 PostgreSQL advisory lock、已持久化 Blueprint 和现有
  DataForSEO request cache/single-flight，避免重复 AI 与付费请求。

### 2.4 审计与历史

新 Blueprint 版本持久化以下脱敏审计字段：

- generator / model
- schema、prompt、rule 版本
- 输入摘要 fingerprint 与字段计数
- source hierarchy
- evidence references

不持久化 Secret、Authorization Header 或完整 Provider Payload。现有数据库中
3 条旧 `blueprint_version=1 / DETERMINISTIC_FALLBACK` 记录仍保留；本轮没有为
验收强制触发真实 Provider 或 AI，因此未伪造新的生产 v2 Blueprint 记录。

## 3. 项目隔离证据

`2026-08-10` 最后只读核对：

| Website Project | Domain | 最新设置版本 | explicit competitors | created_by |
| --- | --- | ---: | --- | --- |
| Aiper | `aiper.com` | 1 | `[]` | `local-product-operator` |
| AWOL Vision | `awolvision.com` | 1 | `[]` | `local-product-operator` |
| ElephTV | `elephtv.com` | 2 | `["showmax.com"]` | `local-product-029` |

ElephTV 历史设置完整保留：

| 版本 | explicit competitors | created_by |
| ---: | --- | --- |
| 1 | `[]` | `local-product-operator` |
| 2 | `["showmax.com"]` | `local-product-029` |

生产 `src` 与本地产品脚本中不再存在 `showmax.com` 或
`DATAFORSEO_DISCOVERY_TARGETS_JSON` 的发现输入消费。该旧环境变量只在定向测试
中作为“应被忽略/应被清除”的兼容性样本出现。

## 4. 验收映射

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| Aiper、AWOL、ElephTV 使用独立 Blueprint 输入 | PASS | Context/设置按 `website_project_id` 与 Context Version 隔离；项目设置只读核对 |
| Aiper、AWOL 不出现 `showmax.com` | PASS | 两项目最新 explicit competitors 均为 `[]` |
| ElephTV 仅显式配置后使用 `showmax.com` | PASS | ElephTV 设置 v1 为空，v2 才加入该域名 |
| 任意新项目不需生产域名硬编码 | PASS | 生产代码无 `showmax.com`；默认设置为空 |
| 同一 Context 不重复 AI/DataForSEO | PASS | service 定向测试中两次执行，AI、SafeFetch、Provider、Gate 各调用一次 |
| AI 不可用仍返回项目正确的非空 fallback | PASS | Blueprint 单元测试覆盖非空、项目排除和无跨项目输入 |
| AI 输出结构化并经过 Schema 校验 | PASS | AI adapter 定向测试 |
| 旧 Blueprint/设置不被原地改写 | PASS | Blueprint v1 和 ElephTV 设置 v1 均仍存在 |

## 5. 验证

在 `backend/core` 执行：

```text
Vitest targeted: 14 files passed, 89 tests passed
npm run typecheck: PASS
targeted ESLint: PASS
npm run build: PASS
git diff --check: PASS
```

定向测试覆盖 Blueprint、来源排序、AI adapter、Context 重复执行缓存、
DataForSEO Runtime 对旧全局变量的忽略、Importer 清理、配置脚本、
production composition、项目设置兼容和 fail-closed 能力。

未执行 `LOCAL-PRODUCT-033` 才允许执行的全量 Backlinks Gate。

## 6. 运行态与 Provider 安全

`2026-08-10 11:00:58 +08:00` 状态脚本结果：

```text
status=ok
runtimeMode=LOCAL_PRODUCT
Frontend HTTP=200
FastAPI HTTP=200
PostgreSQL 18=healthy
Backlinks migration head=0053
Temporal=healthy
DataForSEO enabled=true
DATAFORSEO_MAX_PAID_CALLS=250
DATAFORSEO_ABSOLUTE_BUDGET_MICROS=1000000
AI enabled=false
```

本轮没有新增真实 DataForSEO 或 AI 调用：

```text
Provider Request count=87
latest Provider Request=2026-08-10 01:10:27.160676 UTC
current DataForSEO budget limit=1,000,000 micros
spent=974,052 micros
reserved=0
remaining=25,948 micros
```

最新 Provider Request 早于本轮最终实现与验证；测试继续使用受控 fake，并默认
禁止真实 Provider。没有修改预算上限、`DATAFORSEO_MAX_PAID_CALLS`、历史 Ledger
或 Kill Switch。

## 7. 停止

`LOCAL-PRODUCT-029` 已完成并写入本 Result。按指令停止，不执行
`LOCAL-PRODUCT-030..033`，不 commit，不 push。
