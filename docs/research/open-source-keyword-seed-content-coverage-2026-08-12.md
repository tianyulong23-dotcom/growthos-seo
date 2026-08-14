# SEO 内容规划：固定种子主题选择与老站内容覆盖研究

日期：2026-08-12

## 研究范围与证据口径

本文只研究开源项目源码和 Google 官方资料，不审计本地项目实现。研究问题是：

1. 如何从关键词池选出固定上限（例如 30 个）的独立种子主题；
2. 如何利用老网站的 sitemap、现有 URL、抓取文本和 GSC 历史判断主题是否已使用；
3. 如何在规划阶段避免重复内容和关键词蚕食；
4. 什么情况下应新建内容，什么情况下应更新、合并、规范化或排除已有内容。

证据标签：

- **源码事实**：固定 commit 中可以直接定位的实际规则或计算；
- **官方事实**：Google 官方文档明确说明的行为或限制；
- **可借鉴方案**：根据多个证据组合出的系统设计，不宣称某个项目已经完整实现。

## 结论摘要

1. **没有一个本次核验的项目开箱即用实现“关键词池 -> 固定 30 个主题 -> 老站覆盖排除 -> 内容计划”。** 可行做法是组合关键词评分、语义/SERP 聚类、现有 URL 映射、GSC query-page 映射和内容指纹。
2. **30 应当是上限，不是必须凑满的数量。** 正确语义是“最多选择 30 个已通过质量门槛、且彼此独立、没有被现有页面或未完成计划覆盖的主题”。合格主题不足 30 个时应返回明确缺口，不能用低质量词或重复主题补齐。
3. **关键词库不能只保存 `used=true/false`。** 一个关键词通常属于主题簇，也可能是某个 URL 的次关键词。应保存“主题簇 -> 主关键词/成员词 -> 目标 URL 或计划 -> 决策状态”的分配台账。
4. **先聚类，再取 Top 30。** 如果先按单词分数直接取 30，同一意图的近义词可能占据多个名额并生成多篇竞争页面。低成本流程可以先做语义预聚类，再用 SERP 前 10 结果的 URL 重合确认页面边界，每簇只产生一个种子候选。
5. **老站覆盖判断必须多证据合并。** Sitemap 只是 URL 清单入口；抓取内容补足 title、H1、正文、canonical 和文本指纹；GSC 提供真实的 query-page 历史；已排期和正在写的内容也必须加入覆盖台账。
6. **GSC 无数据不等于未使用。** Search Analytics API 只返回受内部限制的 top rows。低流量、新页面或未获得曝光的页面可能没有记录，因此不能据此自动新建同主题内容。
7. **Canonical 和内容指纹都是后置保护，不是主题覆盖模型。** Canonical 用于合并重复 URL 信号；文本指纹用于发现相同或近似正文。二者都不能单独判断两个不同文本是否争夺同一搜索意图。

## 五个直接相关的开源项目

### 1. SEOmachine：机会评分、GSC 页面映射和旧文动作

项目固定版本：[`e818d5e`](https://github.com/TheCraigHewitt/seomachine/tree/e818d5e38551a931333381d69c43da6e767ec775)

**源码事实：机会评分。** `opportunity_scorer.py` 计算八个子分：volume、position、intent、competition、cluster、CTR、freshness 和 trend。代码标注及实际权重分别为 25%、20%、20%、15%、10%、5%、5%、5%，并以加权和生成 `final_score`；优先级门槛是 `>=80 CRITICAL`、`>=65 HIGH`、`>=45 MEDIUM`、`>=25 LOW`，否则 `SKIP`：

- [八项子分与加权公式](https://github.com/TheCraigHewitt/seomachine/blob/e818d5e38551a931333381d69c43da6e767ec775/data_sources/modules/opportunity_scorer.py#L88-L170)
- [优先级门槛](https://github.com/TheCraigHewitt/seomachine/blob/e818d5e38551a931333381d69c43da6e767ec775/data_sources/modules/opportunity_scorer.py#L365-L394)

需要注意：源码权重相加是 **105%**，不是归一化的 100%。因此它可以证明“多字段评分后设置门槛”的方法，但不应原样复制公式。

**源码事实：GSC query-page 证据。** 该项目按 `query` 维度读取 clicks、impressions、CTR、position；也能先按 `page` 筛选 URL，再查询该页的关键词并按 clicks 排序：

- [query 维度指标读取](https://github.com/TheCraigHewitt/seomachine/blob/e818d5e38551a931333381d69c43da6e767ec775/data_sources/modules/google_search_console.py#L41-L80)
- [指定页面及其 top keywords](https://github.com/TheCraigHewitt/seomachine/blob/e818d5e38551a931333381d69c43da6e767ec775/data_sources/modules/google_search_console.py#L220-L302)

这证明可以把 GSC 转成“query -> page”和“page -> queries”覆盖矩阵，而不是只在关键词表上保存一个模糊的已使用标记。

**源码事实：旧文不应一律新建。** 性能矩阵根据流量、排名和趋势给旧页面分类：表现良好的页面维持或扩展；排名好但流量低的页面优先修正 title/meta；低流量、低排名页面根据程度选择重写、优化、合并或 301：

- [页面分类和建议动作](https://github.com/TheCraigHewitt/seomachine/blob/e818d5e38551a931333381d69c43da6e767ec775/research_performance_matrix.py#L242-L287)

**对本问题的直接价值：** 评分适合产生排序和质量门槛，GSC 映射及页面分类适合决定 `UPDATE_EXISTING`，但该项目本身没有固定选 30 个独立主题的完整选择器。

### 2. SEO-Clustering-Tool：语义预聚类、SERP 重合和簇主词

项目固定版本：[`09f1ac9`](https://github.com/FassihFayyaz/SEO-Clustering-Tool/tree/09f1ac9fef088436ad3f3afb063ea8291962aa74)

**源码事实：SERP 重合聚类。** 默认算法按 volume 或 CPC 降序选择尚未分组的主词，比较候选词与主词的前 N 个 SERP URL；交集数量达到门槛才进入同簇。默认参数是前 10 个 URL、至少 3 个共同 URL：

- [Default、Strict、Balanced Strict 算法](https://github.com/FassihFayyaz/SEO-Clustering-Tool/blob/09f1ac9fef088436ad3f3afb063ea8291962aa74/modules/clustering.py#L13-L192)
- [默认前 10 URL、至少 3 个交集](https://github.com/FassihFayyaz/SEO-Clustering-Tool/blob/09f1ac9fef088436ad3f3afb063ea8291962aa74/ui/tab_serp_clustering.py#L82-L115)

三种规则的差别是：

| 算法 | 入簇条件 | 适用含义 |
|---|---|---|
| Default | 与主词达到 URL 交集门槛 | 簇较宽，适合主题中心初筛 |
| Strict | 与簇内所有成员都达到门槛 | 页面边界严格，但容易产生小簇 |
| Balanced Strict | 潜在簇 2-5 个词需匹配 100% 成员，6-10 个需 80%，11 个以上需 60% | 在严格性和簇增长之间折中 |

**源码事实：主词选择。** UI 在 volume 模式下以 volume 降序、较低 KD 作为次排序；CPC 模式以 CPC 为主、volume 为次排序：

- [簇主词排序规则](https://github.com/FassihFayyaz/SEO-Clustering-Tool/blob/09f1ac9fef088436ad3f3afb063ea8291962aa74/ui/tab_serp_clustering.py#L223-L241)

**源码事实：语义预聚类。** 项目也使用 sentence-transformers embeddings 和 `community_detection`，默认相似度门槛为 0.95、最小簇大小为 2：

- [语义聚类实现](https://github.com/FassihFayyaz/SEO-Clustering-Tool/blob/09f1ac9fef088436ad3f3afb063ea8291962aa74/modules/semantic_clustering.py#L179-L205)

其输出使用簇内最小索引，即输入中最先出现的词作为 parent，并没有再按 volume、KD 或业务价值挑选，因此不能把语义模块输出的 parent 直接当作最终种子：

- [语义簇 parent 选择限制](https://github.com/FassihFayyaz/SEO-Clustering-Tool/blob/09f1ac9fef088436ad3f3afb063ea8291962aa74/modules/semantic_clustering.py#L219-L250)

**对本问题的直接价值：** embedding 适合廉价地缩小比较范围；SERP URL 重合更接近“Google 是否认为这些词应由同一种页面满足”。固定 30 应在 SERP 聚类后按“每簇一个主词”选择，而不是直接取 30 个原始关键词。

### 3. keyword-mapper：Sitemap 全站清单、URL 主词唯一和 Content Gap

项目固定版本：[`36fca21`](https://github.com/maciekpaszkiewicz/keyword-mapper/tree/36fca21153ef1a1d27700e2ce10d7cbcf8861765)

该仓库的核心文件是 Agent 规则文档，而不是带持久化事务的生产服务。以下是**源码中明示的确定性规则**，不能据此宣称其执行可靠性已经过生产验证。

**源码事实：URL inventory。** 规则从业务描述提取 3-5 个初始 seed，并要求解析 sitemap 的 `<loc>`；遇到 sitemap index 时递归读取子 sitemap，抓取失败或 SPA 场景再回退到 crawl4ai map：

- [输入、过滤器和 sitemap 获取顺序](https://github.com/maciekpaszkiewicz/keyword-mapper/blob/36fca21153ef1a1d27700e2ce10d7cbcf8861765/keyword-mapper.md#L22-L43)

**源码事实：完整 URL 映射。** 规则要求最终表包含 URL 清单中的每一个 URL，即使没有关键词数据也要保留。映射时结合 slug 语义、在搜索数据中排名到同一 URL 的词和相似实体：

- [全 URL 清单和语义分组](https://github.com/maciekpaszkiewicz/keyword-mapper/blob/36fca21153ef1a1d27700e2ce10d7cbcf8861765/keyword-mapper.md#L116-L135)

**源码事实：一主词一 URL。** 每个 URL 的 primary keyword 是簇中 search volume 最大的词；一旦分配即锁定，不可再成为另一 URL 的 primary；secondary keywords 最多 5 个并按 volume 降序。intent 与 URL 类型不匹配的词进入 Content Gap，作为新 URL 候选。最终校验要求每个 Primary KW 恰好出现一次：

- [Primary、Secondary、intent 和 anti-cannibalization 校验](https://github.com/maciekpaszkiewicz/keyword-mapper/blob/36fca21153ef1a1d27700e2ce10d7cbcf8861765/keyword-mapper.md#L137-L157)

**对本问题的直接价值：** “关键词是否使用过”应解释为“是否已经分配给某个现有 URL 或未完成计划，以及在该对象中是 primary 还是 secondary”。只有 intent 不匹配且没有合适 URL 时，才进入新内容候选。

### 4. QueryLoom：用 GSC query-page 数据识别蚕食

项目固定版本：[`83cfa31`](https://github.com/publicusdijital-ai/queryloom/tree/83cfa3179b99a5c324172c57b710db0998548a4e)

**源码事实：蚕食判定和评分。** QueryLoom 按 query 聚合页面，只接受 impressions 达到门槛的行；少于两个页面的 query 不继续判断。它计算：

```text
dominant_share = 曝光最高页面的 impressions / 该 query 全部页面 impressions
```

当 `dominant_share < 0.75` 时产生蚕食机会，并使用以下分数：

```text
score = 35
      + pages_count * 8
      + scaled_volume(total_impressions, min_impressions) * 16
      + (0.75 - dominant_share) * 40
```

建议动作包括 consolidation、canonicalization、区分页面 intent，或加强指向 canonical target 的内链：

- [蚕食聚合、0.75 门槛、公式和建议动作](https://github.com/publicusdijital-ai/queryloom/blob/83cfa3179b99a5c324172c57b710db0998548a4e/scripts/mine_gsc_opportunities.py#L277-L316)

项目还按 page 聚合 clicks、impressions、CTR、按 impressions 加权的 position 和 top queries：

- [页面表现摘要](https://github.com/publicusdijital-ai/queryloom/blob/83cfa3179b99a5c324172c57b710db0998548a4e/scripts/mine_gsc_opportunities.py#L356-L378)

**边界：** `dominant_share < 0.75` 是该项目的启发式规则，不是 Google 官方阈值。它只能捕获已经获得 GSC impressions 的 query-page 竞争，不能发现无曝光页面或尚未发布计划之间的主题重复。

**对本问题的直接价值：** 在规划新内容之前，应先检查候选主题的 GSC query 是否已由一个或多个页面承接；若多个页面竞争，应优先进入 `CONSOLIDATE`、`CANONICALIZE` 或 `DIFFERENTIATE`，而不是再创建第三个页面。

### 5. Apache Nutch：正文指纹与重复页面 winner

项目固定版本：[`9bfb979`](https://github.com/apache/nutch/tree/9bfb979f5ba711fecf68ddfad054ddfc10bdac52)

**源码事实：页面签名。** Nutch 默认的 page signature 是 `MD5Signature`，用于重复检测和移除：

- [默认签名配置](https://github.com/apache/nutch/blob/9bfb979f5ba711fecf68ddfad054ddfc10bdac52/conf/nutch-default.xml#L849-L853)

`TextMD5Signature` 对解析后的纯文本计算 MD5；没有文本时回退到默认签名：

- [纯文本 MD5](https://github.com/apache/nutch/blob/9bfb979f5ba711fecf68ddfad054ddfc10bdac52/src/java/org/apache/nutch/crawl/TextMD5Signature.java#L23-L40)

`TextProfileSignature` 会先把文本归一化为小写字母和数字、分词、过滤短词、按词频排序并量化频率，再对 profile 做 MD5。它比原始全文 MD5 更能容忍词序或少量模板变化：

- [文本 profile 生成规则](https://github.com/apache/nutch/blob/9bfb979f5ba711fecf68ddfad054ddfc10bdac52/src/java/org/apache/nutch/crawl/TextProfileSignature.java#L43-L72)

**源码事实：重复页面 winner。** DeduplicationJob 对相同 digest 的 URL 分组，默认保留 crawldb score 更高者；同分时保留 fetchTime 更新者；仍相同时保留 URL 更短者。比较器也可偏好 HTTPS：

- [重复分组和默认 winner 顺序](https://github.com/apache/nutch/blob/9bfb979f5ba711fecf68ddfad054ddfc10bdac52/src/java/org/apache/nutch/crawl/DeduplicationJob.java#L55-L62)
- [score、fetchTime、HTTPS、URL 长度比较](https://github.com/apache/nutch/blob/9bfb979f5ba711fecf68ddfad054ddfc10bdac52/src/java/org/apache/nutch/crawl/DeduplicationJob.java#L182-L247)

**边界：** 内容指纹只证明正文相同或高度近似，不能证明两个不同文本是否满足同一搜索意图。它应作为 exact/near-exact duplicate 的最后一道保护，不能替代主题簇、URL 映射或 GSC 覆盖判断。

## Google 官方资料给出的边界

### GSC Search Analytics

**官方事实：** Search Analytics API 可以按 `query`、`page` 等维度分组，返回 clicks、impressions、CTR 和 position。文档同时说明 page 聚合按 canonical URI 进行，而且 API 不保证返回全部数据行，只返回受内部限制的 top rows：

- [Search Analytics: query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)

直接影响：

- GSC 是老站“真实 query -> canonical page”映射的重要证据；
- GSC 中出现映射可以证明页面曾承接该 query；
- GSC 中没有映射不能证明主题未被使用，仍需检查 sitemap、抓取内容和计划台账。

### Sitemap

**官方事实：** Sitemap 用于告知 Google 网站上的页面和文件，能帮助 URL 发现，但提交 sitemap 不保证 URL 一定被抓取或索引：

- [Google Sitemap 官方说明](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview)

直接影响：Sitemap 适合建立 URL inventory 的起点，但不能代表全部历史 URL，也不能替代抓取、数据库/CMS 导出或 GSC。

### Canonical

**官方事实：** Google 对重复或高度相似页面支持多种 canonicalization 信号。官方文档把 redirect 和 `rel="canonical"` 列为强信号，把 sitemap inclusion 列为弱信号，并说明信号可以叠加：

- [Google 重复 URL 规范化官方说明](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)

直接影响：Canonical 用于告诉搜索引擎重复 URL 的代表页。它不能替代规划前的主题去重，也不应成为“继续生产同主题页面，之后再 canonical”的常规策略。

## 可借鉴方案：从关键词池选择最多 30 个种子主题

以下是组合上述源码事实的设计方案，不是任何单一项目的现成功能。

### 第一步：建立候选字段

关键词池至少保留：

| 字段组 | 建议字段 | 用途 |
|---|---|---|
| 需求 | search volume、GSC impressions、trend | 判断真实需求和趋势 |
| 可行性 | KD、competition | 避免只有需求、没有可竞争性 |
| 价值 | intent、CPC、business relevance | 判断业务价值 |
| 现有表现 | clicks、CTR、position、对应 pages | 判断已有覆盖和优化机会 |
| 主题 | normalized keyword、entities、embedding、SERP URLs、cluster_id | 去重并形成页面级主题 |
| 覆盖 | target_url、canonical_url、coverage evidence、plan/article status | 判断是否已使用 |

关键词“有分”是有价值的，但分数只能负责**排序和门槛**，不能负责主题去重。两个高分近义词仍可能只能生成一个页面。

### 第二步：从词变成独立主题簇

1. 先规范化大小写、空白和明显的精确重复；
2. 用 embedding 相似度做低成本预聚类，缩小需要查询或比较 SERP 的组合；
3. 对潜在同簇关键词比较 SERP 前 10 个自然结果 URL；可从“至少 3 个共同 URL”作为初始门槛；
4. 要求更严格的页面边界时采用 Strict 或 Balanced Strict，不只比较候选词与一个主词；
5. 每个最终簇只保留一个 seed candidate，其他词成为该主题的 secondary/member keywords；
6. 主词默认选 volume 较大者，较低 KD 作为 tie-break；商业型业务可以加入 CPC 和业务相关性，但应保留稳定的最终排序键。

SERP 重合门槛不是行业真理，需要按国家、语言、SERP 波动和查询类型校准；但它比只按字符串共享词根更接近真实搜索意图。

### 第三步：覆盖判断必须先于 Top 30

对每个主题簇依次查：

1. 是否已被现有 URL 分配为 primary 或 secondary；
2. title、H1、slug、正文摘要和 embedding 是否显示已有页面覆盖；
3. GSC 是否已有 query/member keyword -> canonical page 映射；
4. 是否已有计划、草稿或正在生成的文章占用该主题；
5. 多个 URL 是否正在竞争同一 query；
6. 抓取文本是否与现有页面形成 exact/near-exact duplicate；
7. 搜索意图是否不同到足以支持独立 URL。

只有决策为 `CREATE_NEW` 且分数达到质量门槛的主题，才能进入 Top 30。

### 第四步：稳定选择和缺口

```text
clusters = serp_cluster(semantic_prefilter(keyword_pool))
candidates = [choose_primary(cluster) for cluster in clusters]

decisions = [
  coverage_decision(candidate, url_index, gsc_map, plan_ledger)
  for candidate in candidates
]

eligible = [
  item for item in decisions
  if item.action == CREATE_NEW and item.score >= quality_gate
]

selected = stable_sort(
  eligible,
  by = score DESC, volume DESC, kd ASC, normalized_keyword ASC
)[:30]

shortage = 30 - len(selected)
```

关键约束：

- 排序输入应在批次开始时形成快照，避免执行期间数据变化导致翻页漏选或重复选；
- 同一 `cluster_id` 最多选择一个新主题；
- 已占用主题不能因分数高而再次入选；
- 不足 30 时保存 `shortage`，不能从 `UPDATE`、`REVIEW` 或低于门槛的候选中补齐；
- 相同输入必须有稳定 tie-break，保证重跑结果可解释。

## 老网站如何判断“关键词或主题已使用”

### 覆盖索引

应为每个现有 URL 建立可刷新索引：

| 数据 | 建议保存内容 | 能回答的问题 |
|---|---|---|
| URL inventory | URL、来源、last seen、HTTP 状态 | 页面是否存在或曾存在 |
| 页面结构 | title、H1、slug、页面类型 | 页面声称覆盖什么 |
| 正文 | 清洗正文、摘要、embedding、text/profile fingerprint | 内容实际覆盖什么，是否文本重复 |
| 规范化 | declared canonical、resolved canonical、redirect target | 哪个 URL 是代表页 |
| GSC | query、page、clicks、impressions、CTR、position、时间窗 | 用户搜索中哪个页面承接哪个词 |
| 计划台账 | cluster、primary、members、target URL、状态 | 未发布内容是否已占用主题 |

库存来源应合并 sitemap、站内抓取、CMS/数据库导出、重定向历史和 GSC 页面列表，并记录来源。仅使用 sitemap 会漏掉未列入 sitemap 但仍可访问、仍有历史数据或已被 canonical/redirect 的页面。

### 分配台账，而不是 used 布尔值

建议每条主题分配至少保存：

```text
cluster_id / topic_id
primary_keyword
member_keywords
action
target_url / canonical_url
evidence[]
decision_version
status: proposed | planned | drafting | published | retired
created_at / updated_at
```

“已使用”应由状态和关系推导：

- 已发布 URL 覆盖：主题已使用，通常 `EXCLUDE` 或 `UPDATE_EXISTING`；
- `planned` / `drafting`：主题已占用，不可被另一个批次再次选择；
- `retired` 且已重定向：主题仍应关联到目标 URL，不应自动恢复为未使用；
- 一个词作为 secondary：不代表永远禁止独立页面，但必须先证明 intent 和 SERP 页面边界不同；
- 没有 GSC 数据：状态是“GSC 无证据”，不是“未使用”。

## 规划决策表

| 决策 | 证据条件 | 规划动作 |
|---|---|---|
| `EXCLUDE` | 一个现有 canonical URL 已强覆盖主题，内容和表现正常 | 不创建新计划；保留覆盖关系 |
| `UPDATE_EXISTING` | 已有 URL 覆盖主题，但 CTR、排名、内容新鲜度或深度不足 | 更新现有 URL；种子不进入新建 Top 30 |
| `CONSOLIDATE` | 多个 URL 争夺同 query/intent，内容可合并 | 选择代表页，合并内容并处理重定向/内链 |
| `CANONICALIZE` | 多个 URL 内容重复且业务上必须保留多个访问地址 | 选择 canonical target 并统一信号；不再新建同主题 |
| `DIFFERENTIATE` | 页面看似竞争，但可明确拆成不同 intent、受众或任务 | 重定义各页 primary topic、标题和内部链接后再评估 |
| `CREATE_NEW` | 无现有 URL/计划覆盖，intent 独立，SERP 边界清晰，分数过门槛 | 进入排序，最多取 30 个 |
| `REVIEW` | GSC 数据不足、抓取失败、SERP 不稳定或覆盖证据冲突 | 人工复核；不得为凑满 30 自动新建 |

QueryLoom 的 `dominant_share < 0.75` 可作为 `CONSOLIDATE/CANONICALIZE/DIFFERENTIATE` 候选触发器，但不应直接自动执行，因为不同页面可能服务真正不同的 intent。

## 评分建议与门槛

SEOmachine 证明了 volume、position、intent、difficulty、cluster、CTR、freshness、trend 可以形成多因素机会分，但其源码权重总计 105%。落地时有两种更稳妥的做法：

1. 将所选权重重新归一化到 100%；
2. 保留原始子分和解释，只把总分用作排序，不把它伪装成概率。

一个直接可用的归一化示例是：

```text
priority = 0.25 * demand
         + 0.20 * position_opportunity
         + 0.15 * intent_value
         + 0.15 * low_difficulty
         + 0.10 * cluster_value
         + 0.05 * ctr_gap
         + 0.05 * freshness
         + 0.05 * trend
```

这是**可借鉴方案**，不是开源源码原公式。还应把以下条件作为总分之外的硬门槛：

- 与业务和站点主题相关；
- intent 可明确描述；
- 不属于已有 URL 或进行中计划的覆盖簇；
- 没有待处理的严重蚕食冲突；
- 数据证据充分，不处于 `REVIEW`；
- 达到最低需求量或有明确的战略价值例外。

这样可以防止高 volume 抵消“主题已使用”这一事实，也可以防止系统为了凑满 30 把弱主题送入生产。

## 可验证的最小验收标准

1. 输入 100 个关键词，其中 20 个实际属于 5 个 SERP 簇，输出中这 20 个词最多占 5 个种子名额；
2. 一个主题已映射到现有 canonical URL 时，不进入 `CREATE_NEW`；
3. 一个主题已处于 `planned` 或 `drafting` 时，并发批次不能再次选择；
4. GSC 无数据但 title/H1/正文强匹配时，不能自动判定未使用；
5. 同一 query 映射到多页且 dominant share 低于配置门槛时，进入蚕食复核而不是新建；
6. exact/profile fingerprint 相同的页面能被标记为内容重复，但不同指纹不能自动推导为主题不同；
7. 合格独立主题只有 23 个时，结果是 23 个计划和 `shortage=7`；
8. 相同数据快照重跑时，选中的主题及排序一致。

## 不能从这些证据直接推出的结论

- 没有证据表明某个项目已经完整实现生产级的固定 30 内容计划工作流；
- SEOmachine 的权重不能未经归一化直接作为本系统最终公式；
- “SERP 前 10 至少 3 个共同 URL”是项目默认值，不是所有行业通用标准；
- QueryLoom 的 0.75 dominant share 是项目启发式阈值，不是 Google 官方蚕食定义；
- keyword-mapper 的规则文件不是持久化、并发和失败恢复均已验证的后端实现；
- Nutch 指纹发现的是内容重复，不是搜索意图重复；
- Sitemap 完整、GSC 没有数据、页面声明 canonical，任何单项都不足以证明主题未使用或已正确覆盖。

## 最终建议

关键词库与内容计划应通过一个明确的 **topic assignment ledger** 接通，而不是通过“添加到内容计划”按钮或单个 `used` 字段接通。实际选择顺序应固定为：

```text
关键词指标
-> 规范化与语义预聚类
-> SERP 重合确认主题簇
-> 每簇选择一个主词
-> 对照 URL/GSC/正文/计划覆盖索引
-> CREATE / UPDATE / CONSOLIDATE / EXCLUDE / REVIEW
-> 只对 CREATE_NEW 评分排序
-> 最多取 30，明确报告缺口
```

这个模型同时回答了两个核心问题：关键词库的分数负责“先做哪个”，主题簇与覆盖台账负责“是否已经做过、应新建还是更新”。对于老网站，后者必须先于前者。
