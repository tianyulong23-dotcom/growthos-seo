# 网站抓取后企业/品牌/业务信息竞品研究

- 研究日期：2026-07-22
- 研究范围：Jasper、Writesonic、Semrush ContentShake AI、Copy.ai、HubSpot
- 来源范围：仅使用官方产品文档、官方帮助中心或官方产品页面
- 排除范围：不研究网站技术审计、SEO 技术问题、性能评分或错误检测

## 一、核心结论

1. **HubSpot 是本次样本中最接近“输入网站 URL -> 自动抓取 -> 生成结构化企业/品牌档案 -> 用户逐字段确认和编辑”的产品。** 它把结果分为品牌基本信息、品牌故事、视觉识别、品牌语气和理想客户画像，而不是把抓取页面列表直接展示给用户。
2. **Jasper 也支持通过 URL 导入，但把结果拆成 Brand Voice 和 Knowledge 两类资产。** Brand Voice 显式展示语气、风格、语言和个性；企业背景、事实、产品服务、受众等内容进入 Knowledge，供生成内容时调用。
3. **Writesonic、Semrush ContentShake AI 和 Copy.ai 的公开官方流程主要是“分析用户提供的写作样本或知识内容”，不是自动抓取整站并形成完整企业业务档案。** 它们适合作为品牌表达层的参考，不能作为网站业务识别流程的直接证据。
4. 竞品共同做法是：**向用户展示整理后的字段，不直接展示抓取过程和大段原始网页内容；允许用户编辑、重做、选择默认项或确认保存。**
5. 对本项目更合适的产品结构是：抓取结果先在后端形成证据，再在前端展示可确认的业务档案；原始正文、HTML、链接图、Sitemap、抓取队列和模型检索片段不进入主界面。

## 二、产品对比总表

| 产品 | 用户如何导入 | 系统整理的主要内容 | 前端分组与编辑/确认 | 官方资料中未作为业务档案直接展示的内容 |
| --- | --- | --- | --- | --- |
| HubSpot | 在 Brand Identity 中选择从现有内容生成并输入 URL，系统抓取相关网页 | 品牌名称、品牌故事、视觉识别、品牌语气、理想客户画像 | 按 Brand identity、Visual identity、Brand voice、Ideal customer profile 分组；可逐字段编辑 | 原始 HTML、完整网页正文、抓取队列、链接关系和技术指标 |
| Jasper | Brand Voice 和 Knowledge 均可通过文本、文件或 URL 添加内容 | Voice：语气、风格、语言、个性；Knowledge：公司背景、事实、产品/服务、受众/画像等 | Voice 与 Knowledge 分开管理；可编辑、保存、创建多个资产并设置默认项 | 网页原文和检索片段不会被整理成一个统一的企业档案主页 |
| Writesonic | Brand Voice 主要导入至少 150 字的一个或多个写作样本；Knowledge 由用户添加企业资料 | Primary voice、Secondary voice、Tone、Delivery、Style；Knowledge 可保存公司信息、目标受众、产品/服务、品牌规范 | 先展示语气分析结果，再由用户确认保存；知识内容作为独立资产管理 | 官方资料未证明会自动抓取整站，也未展示完整业务档案、抓取页面和原始网页结构 |
| Semrush ContentShake AI | 添加至少 200 字写作样本，可取自首页、关于页、博客、社交内容或邮件 | Tone、Style、Vocabulary、Sentence structure 等品牌表达特征 | Brand Voice 独立管理；可选择、重命名、删除、设为默认或重新分析 | 不直接形成产品线、客户画像等完整业务档案；官方资料未证明会自动抓取输入的网站 |
| Copy.ai | 粘贴 50 至 500 字的已发布内容、博客、社交内容、使命陈述或网页文案；Infobase 支持文本和文件 | Brand Voice：Tone、Style、Language、Audience；Infobase：品牌规范、价值主张、定位、画像和示例内容 | 可编辑、保存或重新分析 Brand Voice，并设置 Teamspace 默认项；文本型 Infobase 可继续编辑 | AI 只选择相关 snippets 供 Chat/Workflow 使用，这些片段不会组成公开的统一企业档案；未证明会自动抓取整站 |

## 三、HubSpot

### 1. 用户如何导入网站

HubSpot 在 `Content > Remix > Settings > Brand Identity` 中提供 `Generate from existing content`。用户输入 URL 后，系统自动抓取相关网页，并据此生成 Brand Identity。

它不是要求用户逐项填写全部企业资料，而是先从网站内容生成一版可编辑结果。

### 2. 系统整理哪些字段

官方帮助文档列出的结构包括：

- Brand name
- Brand story
- Visual identity
  - Logo
  - Favicon
  - Colors
- Brand voice
  - Brand personality
  - Tone of voice
  - Brand vocabulary
- Ideal customer profile
  - Company industry
  - Target markets
  - Location
  - Company employee count
  - Company revenue
  - Buying factors
  - Customer pain points

生成视觉识别时，系统还会从现有内容中提取 logo、favicon、colors、fonts 和 images。官方界面最终重点呈现可复用的品牌字段，而不是页面级抓取数据。

### 3. 前端如何分组和允许用户编辑/确认

- 以 Brand Identity profile 为管理单位，并可创建多个 profile。
- 业务和品牌信息按品牌故事、视觉识别、品牌语气、理想客户画像分组。
- 用户可以逐字段检查和编辑生成结果。
- Brand Identity 与 Brand Kit 关联，便于复用视觉资产。

### 4. 哪些内容不会直接展示

官方帮助页展示的是整理后的品牌档案字段，没有把原始 HTML、全部页面正文、URL 发现队列、站内链接关系、HTTP 状态、响应时间或技术问题作为 Brand Identity 的组成部分。

此外，官方明确说明 Brand Identity 设置用于 Remix，并不会自动影响 HubSpot 的其他区域。

### 5. 官方来源

- HubSpot Knowledge Base, “Generate your brand identity context with AI”  
  URL: https://knowledge.hubspot.com/branding/generate-your-brand-identity-context-with-ai  
  访问日期：2026-07-22

## 四、Jasper

### 1. 用户如何导入网站

Jasper 没有把所有网站信息放进一个统一的“企业档案”，而是提供两类导入入口：

- Brand Voice：可通过 text、file 或 URL 提供品牌写作内容。
- Knowledge：可通过 text、file 或 URL 添加企业知识。

因此，URL 是内容来源之一，但导入后的信息会按“表达方式”和“事实知识”分开管理。

### 2. 系统整理哪些字段

Brand Voice 分析并生成：

- Tone
- Style
- Language
- Personality

Knowledge 适合保存：

- Company background
- Company facts
- Products and services
- Audiences and personas

### 3. 前端如何分组和允许用户编辑/确认

- Brand Voice 与 Knowledge 是两个独立资产区。
- 生成的 voice 可以直接编辑后保存。
- Workspace 可以保存多个 voice 和多个 knowledge asset。
- 用户可以设置 workspace default，控制内容生成时默认使用哪个品牌上下文。

### 4. 哪些内容不会直接展示

Jasper 显式展示的是 Brand Voice 摘要和用户建立的 Knowledge 资产。官方资料没有显示系统会把网页原文、全部抓取页面、内链、Sitemap 或检索过程整理为统一的企业业务档案。

浏览器扩展的 Instant Context 可以利用当前网页上下文，但它是生成时的上下文能力，不等于生成一个供用户确认的结构化企业档案。

### 5. 官方来源

- Jasper Help Center, “Brand Voice”  
  URL: https://help.jasper.ai/hc/en-us/articles/18618666966939-Brand-Voice  
  访问日期：2026-07-22
- Jasper Help Center, “Add knowledge assets to your workspace”  
  URL: https://help.jasper.ai/hc/en-us/articles/18618609726235-Add-knowledge-assets-to-your-workspace  
  访问日期：2026-07-22
- Jasper Help Center, “The Jasper Browser Extension”  
  URL: https://help.jasper.ai/hc/en-us/articles/18618644311707-The-Jasper-Browser-Extension  
  访问日期：2026-07-22

## 五、Writesonic

### 1. 用户如何导入网站或内容

Writesonic 的 Brand Voice 官方流程要求用户添加至少 150 字的写作样本，并可添加多个样本。公开文档描述的是样本输入和分析，没有证明该流程会输入一个域名后自动抓取整站。

Knowledge 用于添加企业信息、目标受众、产品/服务和品牌规范等背景资料，供 AI 生成时使用。

### 2. 系统整理哪些字段

Brand Voice 的分析结果包括：

- Primary voice
- Secondary voice
- Tone
- Delivery
- Style

Knowledge 可承载：

- Company information
- Target audience
- Products and services
- Brand guidelines

### 3. 前端如何分组和允许用户编辑/确认

- Brand Voice 分析完成后展示结果。
- 用户查看结果并确认保存。
- 多个样本共同用于形成品牌语气。
- Knowledge 与 Brand Voice 分开管理，前者保存事实背景，后者保存表达规则。

### 4. 哪些内容不会直接展示

官方文档没有把 Sitemap、抓取页面清单、网页结构、链接关系或技术指标作为 Brand Voice 或 Knowledge 的前端字段，也没有证明系统会从整站自动生成完整企业业务档案。

因此，Writesonic 能证明的是“品牌表达分析”和“企业知识管理”，不能证明“整站业务识别”。

### 5. 官方来源

- Writesonic Documentation, “How to create a Brand Voice”  
  URL: https://docs.writesonic.com/docs/how-to-create-a-brand-voice  
  访问日期：2026-07-22
- Writesonic Documentation, “Brand Voice”  
  URL: https://docs.writesonic.com/docs/brand-voice  
  访问日期：2026-07-22
- Writesonic Documentation, “Knowledge”  
  URL: https://docs.writesonic.com/docs/knowledge  
  访问日期：2026-07-22

## 六、Semrush ContentShake AI

### 1. 用户如何导入网站或内容

ContentShake AI 创建 Brand Voice 时需要至少 200 字的写作样本。Semrush 官方建议样本可来自：

- Homepage
- About Us page
- Blog posts
- Social media posts
- Newsletters

这是用户选择并提供内容样本的流程。官方资料没有证明产品会接收域名并自动抓取、筛选整站页面。

### 2. 系统整理哪些字段

官方资料展示的品牌语气特征主要包括：

- Tone
- Style
- Vocabulary
- Sentence structure

这些字段关注品牌“怎么说”，不覆盖企业“卖什么、卖给谁、为何选择它”的完整业务结构。

### 3. 前端如何分组和允许用户编辑/确认

- Brand Voice 作为独立资产管理。
- 用户可创建多个 Brand Voice。
- 可选择、重命名、删除、设为默认或重新生成分析。
- 写作时选择相应 Brand Voice 应用到内容。

### 4. 哪些内容不会直接展示

官方界面没有把抓取页面、Sitemap、原始网页正文、链接关系或技术指标作为 Brand Voice 字段，也没有显示会自动整理产品线、服务、客户画像、市场范围和价值主张等完整企业业务信息。

### 5. 官方来源

- Semrush Knowledge Base, “How to use ContentShake AI”  
  URL: https://www.semrush.com/kb/1348-how-to-use-contentshake-ai  
  访问日期：2026-07-22
- Semrush Blog, “ContentShake AI Brand Voice”  
  URL: https://www.semrush.com/blog/contentshake-ai-brand-voice/  
  访问日期：2026-07-22
- Semrush Knowledge Base, “ContentShake AI User Manual”  
  URL: https://www.semrush.com/kb/1533-contentshake-ai-user-manual  
  访问日期：2026-07-22

## 七、Copy.ai

> 说明：以下页面仍由当前 Fullcast 官方支持站托管，但页面元数据显示为 `stale: true`。它们可用于说明 Copy.ai 已公开过的产品交互，不宜在未经产品内验证的情况下视为 2026 年仍完全一致的现行能力。

### 1. 用户如何导入网站或内容

Brand Voice 要求用户粘贴 50 至 500 字的内容，来源可以是已发布内容、博客、社交内容、mission statement 或 webpage copy。

Infobase 支持直接输入或粘贴文本，也支持 PDF、TXT、DOC、DOCX 文件。官方资料没有证明用户输入域名后系统会自动抓取整站。

### 2. 系统整理哪些字段

Brand Voice 分析结果包括：

- Tone
- Style
- Language
- Audience

Infobase 适合保存：

- Brand and style guidelines
- Value propositions and positioning documents
- Persona information
- Examples and sample content

### 3. 前端如何分组和允许用户编辑/确认

- Brand Voice 分析后，用户可以编辑、保存或选择 `Redo Analysis`。
- 可以设置 Teamspace 默认 Brand Voice。
- Infobase 作为独立知识资产管理。
- 直接输入或粘贴的文本型 Infobase 内容可在界面中继续编辑。
- 可使用 tags 组织 Infobase 内容。

### 4. 哪些内容不会直接展示

官方说明 AI 在 Chat 或 Workflow 中只选择最相关的 snippets 使用。这些被检索的片段属于生成上下文，不会自动组成一个面向用户的统一企业业务档案。

官方资料也没有显示会直接展示整站页面清单、原始 HTML、站内链接、Sitemap 或抓取过程。

### 5. 官方来源

- Fullcast Support, Copy.ai, “Getting Started with Brand Voice”  
  URL: https://support.fullcast.com/copy-ai/docs/getting-started-with-brand-voice.md  
  访问日期：2026-07-22
- Fullcast Support, Copy.ai, “Getting Started with Infobase”  
  URL: https://support.fullcast.com/copy-ai/docs/getting-started-with-infobase.md  
  访问日期：2026-07-22
- Fullcast Support, Copy.ai, “Infobase Tags User Guide”  
  URL: https://support.fullcast.com/copy-ai/docs/infobase-tags-user-guide.md  
  访问日期：2026-07-22

## 八、对本项目的产品建议

### 1. 前端应展示的业务档案

综合官方竞品做法，网站抓取完成后，建议整理并展示以下分组：

#### 企业概况

- 企业或品牌名称
- 一句话业务简介
- 详细业务说明
- 行业
- 商业模式
- 总部或主要地区
- 目标国家、市场和语言

#### 产品与服务

- 核心产品线
- 核心服务
- 主要使用场景
- 定价或购买方式（有明确证据时）

#### 目标客户

- 客户类型
- 目标行业
- 目标角色或人群
- 企业规模
- 目标地区
- 客户痛点
- 购买因素

#### 品牌定位

- 价值主张
- 差异化
- 品牌故事
- 可信度证据，如客户、案例、认证或公开数据

#### 品牌表达

- 品牌个性
- 语气
- 词汇偏好
- 写作风格

#### 视觉识别

- Logo
- Favicon
- 主色

### 2. 用户确认方式

- 每个字段都应允许编辑，而不是只提供一个不可修改的 AI 总结。
- 字段旁可显示一个或多个来源 URL，帮助用户核对证据。
- 对缺乏证据的字段显示“未识别”，不要强行补全。
- 支持“确认”“已修改”和“待确认”等字段状态。
- 支持重新抓取或重新整理，但不应因重跑覆盖用户已经确认的内容。
- 品牌语气和企业事实应分组管理，避免把“怎么表达”与“实际卖什么”混为一谈。

### 3. 不应放在业务档案主界面的内容

以下信息可以保留在后端，用于溯源、重新处理和质量控制，但不应作为企业业务档案的主要展示内容：

- 原始 HTML
- 完整页面正文
- Sitemap 原文
- 全量站内链接和外链
- URL 发现队列
- 抓取深度和页面优先级
- HTTP 状态、响应时间和重试记录
- JavaScript 渲染过程
- AI 检索到的全部 chunks
- 模型中间推理
- 技术审计问题

前端需要的是“可核对、可编辑、可复用的业务结论”，不是爬虫运行控制台。

## 九、最终判断

竞品没有形成“所有产品都用同一套整站抓取业务档案”的统一模式。现有官方证据显示：

- **HubSpot** 最完整地实现了网站 URL 到结构化、可编辑 Brand Identity 的闭环。
- **Jasper** 采用 Brand Voice 与 Knowledge 分层，适合参考业务事实和品牌表达的边界。
- **Writesonic、Semrush ContentShake AI、Copy.ai** 更适合参考品牌语气分析、知识资产管理和用户确认方式，不能用来证明整站自动业务识别。

因此，本项目应把网站抓取定位为业务识别的数据来源：后端保存页面证据，AI 将证据整理为结构化业务档案，前端只展示业务结论、来源和确认状态。该流程应与技术审计彻底分离。
