# 无会话 API 下的长文章生成：成熟开源项目共同模式

日期：2026-08-13

## 结论

长文章生成不应该依赖模型会话记忆。成熟项目的共同做法是：**把记忆放在模型之外，把长任务拆成可恢复阶段，把每次模型调用限制为一个小而明确的产物**。

对 `F:\seo-main` 最合适的方案不是更换现有 Temporal 工作流，也不是把通用写作模板全文塞进每次请求，而是在现有链路上继续强化以下机制：

1. 以 `run_id + stage + unit_id` 管理任务，阶段完成后持久化结构化产物。
2. 每次调用只装配四层上下文：精简规则、全局文章简报、当前章节合同、当前章节相关证据与少量相关历史摘要。
3. 正文按章节生成；导言、结论和全局编辑在正文完成后串行执行。
4. 用持久化的“一致性账本”维持标题、用户意图、语气、术语、事实口径和已覆盖问题，而不是依赖完整前文。
5. 先预留输出 token，再计算可用输入预算；超限时优先裁掉低相关材料，其次压缩，不能简单截断关键证据。
6. 只重试幂等的小调用，使用确定性请求键复用成功结果；对 429、5xx、超时采用有上限的指数退避。
7. 研究和相互独立的正文段落可以有限并发；导言、结论、全局检查和修改应串行或按问题定点执行。

现有 `F:\seo-main` 已经实现了其中大部分基础设施：Temporal 分阶段编排、S3 阶段产物、类型化文章计划、章节独立保存与恢复、确定性模型请求缓存、有限并发、失败降级和局部修订。应在此基础上补齐统一 token 预算器、全局一致性账本，以及基于相关性的历史章节摘要选择。

## 一、共同架构

```mermaid
flowchart LR
    A[输入与文章简报] --> B[研究与证据账本]
    B --> C[大纲与章节合同]
    C --> D[按章节检索相关证据]
    D --> E[有限并发生成正文]
    E --> F[更新章节摘要和一致性账本]
    F --> G[串行生成导言与结论]
    G --> H[确定性检查和定点修订]
    H --> I[最终组装与发布产物]
```

阶段之间传递的不是聊天记录，而是可校验、可引用、可恢复的结构化产物：

| 阶段 | 建议持久化产物 | 后续用途 |
|---|---|---|
| 输入整理 | `article_brief`、锁定要求、受众、搜索意图、语言和语气 | 每次调用的短全局约束 |
| 研究 | 来源记录、证据片段、事实声明、URL、抓取时间 | 按章节检索，避免整包重复传入 |
| 规划 | 大纲、章节目标、覆盖点、字数目标、证据绑定 | 形成每章独立合同 |
| 写作 | 章节草稿、章节摘要、使用的声明和来源 | 恢复、去重和保持衔接 |
| 一致性 | 标题、术语、实体、数字口径、已回答问题、标题清单 | 在独立调用间保持统一 |
| 质量 | 问题代码、问题章节、严重度、可否修复、尝试次数 | 只修问题章节，不重写全文 |
| 运行 | 状态、产物引用、请求键、token 用量、错误和重试信息 | 幂等恢复、成本与故障分析 |

## 二、开源项目源码证据

### 1. Stanford STORM

版本：[`fb951af`](https://github.com/stanford-oval/storm/tree/fb951af7744dab086e34962e9bc6fe878e145f83)

**源码事实**

- [`STORMWikiRunner.run`](https://github.com/stanford-oval/storm/blob/fb951af7744dab086e34962e9bc6fe878e145f83/knowledge_storm/storm_wiki/engine.py#L211-L310) 明确拆成资料研究、大纲、文章生成和润色阶段。
- 同一运行器会保存并重新加载 `conversation_log.json`、`raw_search_results.json`、`storm_gen_outline.txt`、`storm_gen_article.txt`、`url_to_info.json`、`run_config.json` 和 `llm_call_history.jsonl`，允许跳过已经完成的阶段，见 [`engine.py`](https://github.com/stanford-oval/storm/blob/fb951af7744dab086e34962e9bc6fe878e145f83/knowledge_storm/storm_wiki/engine.py#L312-L440)。
- 知识整理阶段按不同人物视角并发研究，但使用有界线程池，见 [`_run_conversation`](https://github.com/stanford-oval/storm/blob/fb951af7744dab086e34962e9bc6fe878e145f83/knowledge_storm/storm_wiki/modules/knowledge_curation.py#L286-L345)。
- 大纲生成前会清除引用标记，并把对话材料限制在 5,000 词以内，见 [`WriteOutline.forward`](https://github.com/stanford-oval/storm/blob/fb951af7744dab086e34962e9bc6fe878e145f83/knowledge_storm/storm_wiki/modules/outline_generation.py#L84-L125)。
- 文章生成时，每个一级章节用自己的章节大纲作为检索查询；默认只取 top 5 资料，并以最多 10 个线程并发写章节。单章写作证据限制在 1,500 词，见 [`article_generation.py`](https://github.com/stanford-oval/storm/blob/fb951af7744dab086e34962e9bc6fe878e145f83/knowledge_storm/storm_wiki/modules/article_generation.py#L15-L159)。

**可复用规律**

STORM 的关键不是保留长对话，而是“阶段文件 + 章节级检索 + 章节级写作”。它证明了完整文章不需要一次模型调用完成，也不需要把全部研究资料发送给每个章节。

**局限**

这些本地文件能支持阶段分离和简单恢复，但不等于生产级工作流的事务、幂等和并发控制。`F:\seo-main` 已有 Temporal 和对象存储，不应退回文件目录式编排。

### 2. GPT Researcher

版本：[`5d84d2f`](https://github.com/assafelovic/gpt-researcher/tree/5d84d2f5553e70a2765a8ff3a0d2672d60437ce8)

**源码事实**

- [`DetailedReport.run`](https://github.com/assafelovic/gpt-researcher/blob/5d84d2f5553e70a2765a8ff3a0d2672d60437ce8/backend/report_type/detailed_report/detailed_report.py#L72-L202) 按“初始研究 -> 子主题 -> 导言 -> 子主题报告 -> 结论”执行。它维护 `existing_headers`、`global_context` 和 `global_written_sections`，子主题依次写入并更新全局状态。
- 写当前子主题时，不是无条件附带所有已写内容，而是根据当前主题和拟定标题检索相似的历史段落，见 [`_get_subtopic_report`](https://github.com/assafelovic/gpt-researcher/blob/5d84d2f5553e70a2765a8ff3a0d2672d60437ce8/backend/report_type/detailed_report/detailed_report.py#L110-L190)。
- [`ContextManager`](https://github.com/assafelovic/gpt-researcher/blob/5d84d2f5553e70a2765a8ff3a0d2672d60437ce8/gpt_researcher/skills/context_manager.py#L37-L155) 对研究材料和已写内容做相关性检索，分别限制候选数量，而不是传入完整语料。
- [`ContextCompressor`](https://github.com/assafelovic/gpt-researcher/blob/5d84d2f5553e70a2765a8ff3a0d2672d60437ce8/gpt_researcher/context/compression.py#L36-L154) 将材料切成约 1,000 字符、100 字符重叠的块，再用嵌入相似度筛选；已写内容也有独立压缩器，见同文件的 [`WrittenContentCompressor`](https://github.com/assafelovic/gpt-researcher/blob/5d84d2f5553e70a2765a8ff3a0d2672d60437ce8/gpt_researcher/context/compression.py#L191-L230)。
- 深度研究设置 25,000 词上下文上限，并通过 `asyncio.Semaphore` 限制并发；分支用 `gather` 执行，失败分支可单独返回空值，研究深度增加时还会缩小广度，见 [`deep_research.py`](https://github.com/assafelovic/gpt-researcher/blob/5d84d2f5553e70a2765a8ff3a0d2672d60437ce8/gpt_researcher/skills/deep_research.py#L213-L249) 和 [`deep_research.py`](https://github.com/assafelovic/gpt-researcher/blob/5d84d2f5553e70a2765a8ff3a0d2672d60437ce8/gpt_researcher/skills/deep_research.py#L380-L566)。

**可复用规律**

GPT Researcher 补充了 STORM 不够明确的一点：长文一致性不要求携带完整前文，可以持久化历史章节，再根据当前章节标题和目标检索最相关的少量历史内容。

**局限**

按最近内容保留 25,000 词只能作为最终防溢出措施，不能作为主要上下文策略。SEO 文章需要优先保留与当前章节绑定的事实、来源和要求，不能让“最近写入”覆盖“最相关”。

### 3. LangGraph

版本：[`644815f`](https://github.com/langchain-ai/langgraph/tree/644815f9e5bc52ad8f7a5227a456227e9c3e639b)

**源码事实**

- LangGraph checkpointer 在每个 superstep 保存图状态，通过 `thread_id` 标识一条运行记录，也可以从指定 `checkpoint_id` 恢复，见 [`libs/checkpoint/README.md`](https://github.com/langchain-ai/langgraph/blob/644815f9e5bc52ad8f7a5227a456227e9c3e639b/libs/checkpoint/README.md#L19-L54)。
- 当并行节点中一个失败时，成功兄弟节点的 pending writes 会保留，恢复后无需重复执行成功节点。
- Postgres saver 面向持久、长时间运行的工作流，见 [`libs/checkpoint-postgres/README.md`](https://github.com/langchain-ai/langgraph/blob/644815f9e5bc52ad8f7a5227a456227e9c3e639b/libs/checkpoint-postgres/README.md#L56-L66)。
- [`run_with_retry` / `arun_with_retry`](https://github.com/langchain-ai/langgraph/blob/644815f9e5bc52ad8f7a5227a456227e9c3e639b/libs/langgraph/langgraph/pregel/_retry.py#L575-L850) 按异常选择重试策略，限制最大尝试次数，并支持指数退避、最大间隔、抖动和异步节点超时。

**对本项目的价值**

价值在于 checkpoint 语义：记录每个阶段和章节单元的完成状态，恢复时只执行缺失单元。`F:\seo-main` 已使用 Temporal，因此应借鉴状态和重试模型，不应为了长文生成引入第二套工作流引擎。

### 4. LlamaIndex

版本：[`a2b8ee2`](https://github.com/run-llama/llama_index/tree/a2b8ee27b20c834d1963c1b93316635ae0499a5e)

**源码事实**

- [`PromptHelper._get_available_context_size`](https://github.com/run-llama/llama_index/blob/a2b8ee27b20c834d1963c1b93316635ae0499a5e/llama-index-core/llama_index/core/indices/prompt_helper.py#L146-L165) 用“模型上下文窗口 - prompt token - 预留输出 token”计算可用材料空间；若为负数则直接报错。
- [`PromptHelper.repack`](https://github.com/run-llama/llama_index/blob/a2b8ee27b20c834d1963c1b93316635ae0499a5e/llama-index-core/llama_index/core/indices/prompt_helper.py#L277-L296) 根据可用上下文重新组合和切分材料。
- [`CompactAndRefine`](https://github.com/run-llama/llama_index/blob/a2b8ee27b20c834d1963c1b93316635ae0499a5e/llama-index-core/llama_index/core/response_synthesizers/compact_and_refine.py#L17-L59) 先按 QA/refine 两个提示中更大的上下文需求重打包，再逐步精炼。
- [`TreeSummarize`](https://github.com/run-llama/llama_index/blob/a2b8ee27b20c834d1963c1b93316635ae0499a5e/llama-index-core/llama_index/core/response_synthesizers/tree_summarize.py#L77-L153) 在材料无法一次放入时并发总结各块，再递归总结摘要。
- 文档摘要检索器默认只返回 top-k 摘要节点，见 [`DocumentSummaryIndexEmbeddingRetriever`](https://github.com/run-llama/llama_index/blob/a2b8ee27b20c834d1963c1b93316635ae0499a5e/llama-index-core/llama_index/core/indices/document_summary/retrievers.py#L125-L174)。

**可复用规律与局限**

token 控制必须是调用前的确定性计算，而不是等 API 报上下文过长后再处理。树形摘要适合压缩大规模背景，但摘要可能丢失数字、限定条件和引用，因此事实证据账本必须独立保留，不能只保存自然语言摘要。

## 三、六个问题的直接答案

### 1. 如何拆阶段

建议固定为：输入规范化 -> 研究采集 -> 证据整理 -> 文章规划 -> 正文章节写作 -> 导言/结论/FAQ -> 全局组装 -> 确定性检查 -> 定点修订 -> 完成。

一个阶段可以有多个独立单元，例如一个来源、一个研究分支或一个章节。工作流只调度单元，不在内存中维持模型会话。

### 2. 阶段间持久化什么

优先保存 JSON 类型化产物，而不是保存一段越来越长的“历史提示词”。最低集合是：

- 文章简报与锁定要求。
- 来源、证据片段和事实声明账本。
- 文章计划与章节合同。
- 章节到声明/来源的绑定。
- 每章草稿、短摘要和使用过的来源。
- 一致性账本与标题清单。
- 质量问题、修订范围、请求键、用量和重试状态。

### 3. 每次调用如何选择上下文

每次独立请求按优先级装配：

1. **固定规则**：压缩后的写作原则和禁止事项。
2. **全局简报**：文章目标、受众、搜索意图、标题、语言、语气和关键术语。
3. **当前单元合同**：章节目标、覆盖点、目标长度和必须回答的问题。
4. **动态材料**：绑定事实、top-k 相关来源片段、相关历史章节摘要。

超预算时按相反优先级淘汰：低相关竞品材料 -> 冗余搜索摘要 -> 低相关历史摘要 -> 非必需示例。不得裁掉锁定要求、当前章节合同和必须引用的证据。

### 4. 如何分段写作并保持一致

先生成正文主体，再根据完整正文的压缩表示生成导言、结论和 FAQ。正文可以有限并发，但每章必须遵循同一个文章简报和章节合同。

建议新增持久化一致性账本，至少包含：

- 锁定标题、核心搜索意图、受众和承诺。
- 术语表、实体名称、产品名称、单位和数字口径。
- 已覆盖问题与所在章节。
- 已使用标题和每章 200–500 token 摘要。
- 关键结论、立场和不能互相矛盾的事实。

写新章节时，不必附带所有前文；用当前章节目标检索最相关的 2–4 个章节摘要。结论阶段再读取所有章节摘要和关键结论。

### 5. token、摘要、超时、重试和并发

**Token 预算**

每次调用先计算：

```text
可用证据 token = 模型上下文上限
                - 固定提示和 JSON Schema
                - 全局简报
                - 当前章节合同
                - 预留输出 token
                - 安全余量
```

预算应按调用类型配置，而不是只设一个全局字符上限。规划、单章写作、导言、结论、检查和修订所需输出空间不同。记录实际 input/output token，用真实分布持续调整预算。

**摘要与压缩**

摘要用于导航和一致性，原始证据用于事实写作。两者必须同时保存。先做相关性筛选，再对入选材料压缩；不要先把所有来源总结成一个大摘要，否则无法可靠追溯事实。

**超时与重试**

- 工作流阶段超时和单次 API 请求超时分开设置。
- 只重试 429、暂时性 5xx、连接错误和有限次数的超时。
- 鉴权错误、无效请求和确定性 schema 不匹配不能无限重试。
- 使用 `run_id + stage + unit_id + payload_hash` 形成幂等键；成功响应落库后，恢复时直接复用。
- 指数退避必须有最大次数、最大间隔和随机抖动。

**并发**

- 来源抓取、研究分支：中等并发。
- 相互独立的正文段落：有限并发。
- 第一节可先串行生成，为后续段落提供基调。
- 导言、结论、全局组装和最终检查：正文完成后串行。
- 失败只重跑对应章节或研究分支，不重跑整篇文章。

### 6. 哪些做法适合 `F:\seo-main`

## 四、现有链路映射

### 已经具备，应保留

- [workflows.py](F:/seo-main/backend/api/app/modules/content/workflows.py) 已按 preparing、collecting、competitor research、planning、writing、editing、checking 和 bounded revising 分阶段，由 Temporal 提供长任务编排、阶段超时和重试。
- [writing_gateway.py](F:/seo-main/backend/api/app/modules/content/writing_gateway.py) 已定义 `EvidenceClaim`、`ArticleContract`、`ArticlePlan`、`SectionDraft`、`UnifiedArticle`、`SectionIssue` 和 `RevisedSections` 等类型化产物，并使用结构化 JSON Schema。
- [generation.py](F:/seo-main/backend/api/app/modules/content/generation.py#L76) 的 `cached_generate` 将运行、阶段、修订次数、调用类型和 payload 哈希为确定性请求键，并把成功调用保存到对象存储。这正是无会话 API 所需的外部记忆与幂等机制。
- [generation.py](F:/seo-main/backend/api/app/modules/content/generation.py#L148) 的规划阶段保存研究包和类型化计划；失败后会使用压缩研究包重试，并有确定性降级。
- [generation.py](F:/seo-main/backend/api/app/modules/content/generation.py#L536) 的章节写作按章节保存独立产物、恢复已完成章节、使用有界 semaphore，并只向后续章节提供最近两个章节摘要；导言、结论和 FAQ 在主体之后生成。
- [`section_payload`](F:/seo-main/backend/api/app/modules/content/generation.py#L2926) 已按章节选择绑定 claims、来源、内部链接、项目资料和历史摘要，而不是发送完整研究包。
- [`check_article`](F:/seo-main/backend/api/app/modules/content/generation.py#L1020) 当前主要执行确定性质量检查；[`revise_article_sections`](F:/seo-main/backend/api/app/modules/content/generation.py#L1131) 只把失败章节及其目标和声明发送给模型，符合定点修订原则。
- [config.py](F:/seo-main/backend/api/app/core/config.py#L65) 已将章节写作并发默认设为 3，并限制在 1–6。

### 需要补齐，按优先级实施

#### P0：统一调用级 token 预算器

目前已有来源数量、摘录长度、claim 数量、compact payload 和摘要长度限制，但它们主要是分散的条数/字符规则。建议在进入 `WritingGateway` 前统一按模型 tokenizer 计算预算：预留输出和 schema 后，再按优先级装配材料，并把裁剪原因、估算 token 和实际用量写入调用记录。

#### P0：把通用写作模板编译成短文章简报

通用模板是指导，不是强制审核条件。规划阶段根据文章类型、用户意图和现有资料，把模板编译为本次运行的短 `writing_brief`，只保留适用原则；章节调用只读取该 brief 和当前章节合同。不要在每次调用中重复完整模板，也不要把模板所有建议变成硬性质量门槛。

#### P1：持久化全局一致性账本

现有 `previous_section_summaries` 能提供局部衔接，但不足以稳定维护跨全文术语、数字和结论。建议每章成功后更新结构化 `consistency_ledger`，并把它作为阶段产物保存。账本只记录决策和覆盖状态，不保存全文。

#### P1：从“最近两个摘要”升级为“相关摘要 top-k”

最近章节适合处理过渡，不一定与当前主题最相关。保留最近一章作为邻接上下文，再按当前章节标题、目标和覆盖点，从全部既有章节摘要中检索 1–3 个最相关摘要。这样可兼顾文章流畅度和跨章节去重。

#### P1：控制全篇统一编辑的上下文风险

[`unify_article`](F:/seo-main/backend/api/app/modules/content/generation.py#L866) 会把完整章节列表放进一次模型调用。文章变长后，这是最明确的 token 和超时风险。建议优先使用确定性组装；需要模型编辑时，先生成全局问题清单，再按章节定点修改。只有文章规模落在预算内时才允许整篇统一编辑。

#### P2：补齐每次模型调用的运行可观测性

除 input/output token 外，建议记录估算 token、上下文构成、被裁掉的材料、attempt、错误类别、退避时长、是否命中缓存和最终降级路径。这样才能判断超时究竟来自 payload、模型、并发还是供应商限流。

## 五、建议的独立请求结构

```json
{
  "run": {
    "run_id": "...",
    "stage": "writing",
    "unit_id": "section-03",
    "attempt": 1
  },
  "writing_brief": {
    "intent": "...",
    "audience": "...",
    "language": "...",
    "tone": ["..."],
    "guidance": ["仅保留本篇适用的写作建议"]
  },
  "section_contract": {
    "heading": "...",
    "objective": "...",
    "coverage_points": ["..."],
    "word_target": 500
  },
  "consistency": {
    "locked_terms": {},
    "key_decisions": [],
    "covered_questions": [],
    "adjacent_summary": "...",
    "relevant_summaries": []
  },
  "evidence": {
    "claims": [],
    "source_chunks": []
  },
  "budget": {
    "context_limit": 0,
    "reserved_output_tokens": 0,
    "estimated_input_tokens": 0
  }
}
```

该结构不是要求所有字段都直接发送给模型。运行、预算和追踪字段可以仅供服务端记录；模型只接收完成当前任务所需的最小上下文。

## 六、最终判断

`F:\seo-main` 的方向已经与成熟开源项目一致，当前问题不是“API 没有上下文”，而是要把外部上下文管理做得更明确、更可预算：

- Temporal 和 S3 负责长任务记忆与恢复。
- 类型化产物负责阶段合同。
- 章节级检索负责控制输入。
- 章节摘要与一致性账本负责跨调用统一。
- token 预算器负责在请求发出前防止超限。
- 确定性请求键、有限重试和章节级产物负责降低超时与重复成本。

因此，不需要引入模型会话，也不需要一次生成整篇文章。最小且最有效的下一步是：**增加统一 token 预算器、持久化一致性账本、将最近摘要选择改为“邻接 + 相关 top-k”，并限制整篇模型编辑只在预算允许时执行。**

## 来源版本

| 项目 | 核验 commit | 官方仓库 |
|---|---|---|
| Stanford STORM | `fb951af7744dab086e34962e9bc6fe878e145f83` | <https://github.com/stanford-oval/storm> |
| GPT Researcher | `5d84d2f5553e70a2765a8ff3a0d2672d60437ce8` | <https://github.com/assafelovic/gpt-researcher> |
| LangGraph | `644815f9e5bc52ad8f7a5227a456227e9c3e639b` | <https://github.com/langchain-ai/langgraph> |
| LlamaIndex | `a2b8ee27b20c834d1963c1b93316635ae0499a5e` | <https://github.com/run-llama/llama_index> |
