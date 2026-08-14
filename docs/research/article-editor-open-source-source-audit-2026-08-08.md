# 文章编辑与生产闭环开源项目源码审计

- 审计日期：2026-08-08
- 产品仓库：`F:\seo-main`
- 第三方源码目录：`F:\seo-open-source-references`
- 审计范围：文章文档、编辑器、媒体、保存恢复、版本、SEO、审核、预览、发布和 AI 辅助编辑
- 本轮边界：只拉取和审计第三方源码，不修改产品功能，不评估站外链接建设

## 一、结论

没有一个开源项目完整覆盖本项目所需的“生成后编辑 -> SEO 优化 -> 审核 -> 预览 -> 发布 -> 追踪”业务。成熟做法不是更换 TipTap，也不是从某个项目复制一套 UI，而是保留 TipTap 作为编辑内核，按业务层组合参考：

1. **TipTap**：负责文档节点、编辑命令和插件扩展点。它不负责上传、自动保存、版本、审核和发布。
2. **Ghost Koenig**：参考结构化内容卡片、图片/图库/视频/音频/文件上传体验，以及编辑器与宿主上传服务之间的契约。
3. **Gutenberg + WordPress Core**：参考 dirty 状态、服务器自动保存、本地备份、预览、外部图片导入、媒体上传锁、修订与恢复。
4. **Ghost**：参考本地修订、离开保护、自动保存收尾、版本保留和草稿/定时/已发布状态。
5. **Rank Math**：参考 SEO 字段、逐项检查、加权评分、主次关键词差异化检查和桌面/移动 SERP 预览。
6. **Wagtail**：参考审核任务、退回重提、角色、锁、定时发布和审计日志。
7. **Novel**：参考 AI 选区改写、流式候选结果、替换或插入操作。它只是交互参考，不是完整 CMS。

当前产品已经有独立全屏编辑工作区、手动保存、乐观并发、永久版本、审核决定和 WordPress 发布幂等治理，但仍是“文章正文审核发布骨架”。与成熟产品相比，主要缺口是：结构化媒体资产、可靠自动保存和本地恢复、SEO 可编辑分析、职责分离的审核工作流、草稿预览、定时发布和远端媒体同步、结构化 diff，以及可追踪的 AI 选区编辑。

因此，不能把后续工作简化成增加几个工具栏按钮。每个能力都必须同时完成数据模型、API、前端状态、失败恢复、权限、审计和测试。

## 二、固定源码版本

以下仓库均已浅克隆到本机，并核验远端与 HEAD。后续实现讨论必须以固定提交为准，避免引用漂移。

| 项目 | 本地目录 | 固定提交 | 本次参考职责 |
| --- | --- | --- | --- |
| Gutenberg | `F:\seo-open-source-references\gutenberg` | `c7cdb48` | 编辑状态、自动保存、本地备份、预览、媒体导入 |
| WordPress Core | `F:\seo-open-source-references\wordpress-core` | `cdc5934` | autosave REST、revision、恢复和保留策略 |
| Rank Math | `F:\seo-open-source-references\rank-math` | `e105b4f` | SEO 分析、评分、检查清单、SERP 预览 |
| Ghost | `F:\seo-open-source-references\ghost` | `5406605` | 本地修订、离开保护、版本策略、发布状态 |
| Koenig | `F:\seo-open-source-references\koenig` | `4da8318` | 结构化内容卡片和上传链路 |
| Wagtail | `F:\seo-open-source-references\wagtail` | `fb5f684` | 审核工作流、锁、定时发布、审计日志 |
| Novel | `F:\seo-open-source-references\novel` | `fa95098` | AI 选区操作、流式候选、图片上传占位 |
| TipTap | `F:\seo-open-source-references\tiptap` | `d18533a` | 当前编辑器底层节点、命令和扩展机制 |

## 三、当前产品基线

### 3.1 已实现

- 独立全屏文章工作区，不再挤在原内容列表窗口中：`frontend/src/features/content/article-workspace.tsx:535-571`。
- TipTap 基础正文编辑和链接命令：`frontend/src/features/content/article-editor.tsx:1-201`。
- 手动保存、dirty 提示和保存后刷新审核版本：`frontend/src/features/content/article-workspace.tsx:272-287`。
- `review_version` 乐观并发检查：`backend/api/app/modules/content/repository.py:875-944`。
- 手动保存生成 `manual_edit` 永久版本，并使旧审核失效：`backend/api/app/modules/content/repository.py:875-944`。
- 历史恢复不覆盖原版本，而是创建新的 `restored` 版本：`backend/api/app/modules/content/repository.py:993-1099`。
- 审核决定与版本绑定，同一审核版本只接受一次决定：`backend/api/app/modules/content/repository.py:802-862`。
- 发布门禁、幂等键、`submitting` 和 `uncertain` 状态治理：`backend/api/app/modules/content/repository.py:1109-1306`。

### 3.2 部分实现

- 文档有后端 JSON 校验，但只接受基础文本 block、`text`、`hardBreak` 和少量 mark；未知节点及字段直接拒绝：`backend/api/app/modules/content/document.py:16-27`、`backend/api/app/modules/content/document.py:110-124`、`backend/api/app/modules/content/document.py:188-222`。
- 版本 diff 使用 Markdown 行级 `SequenceMatcher`，能看文本变化，但不能表达 block 移动、图片替换、链接属性或 SEO 元数据变化：`backend/api/app/modules/content/service.py:825-901`。
- SEO 标题、slug、meta title、meta description 已存在于文章数据中，但工作区主要是只读展示，保存请求不形成完整可编辑 SEO 契约：`backend/api/app/modules/content/schemas.py:43-53`、`frontend/src/features/content/article-workspace.tsx:674-696`。
- 发布支持 WordPress 文章端点，但 payload 只有 title、content、status、slug、excerpt：`backend/api/app/modules/content/service.py:638-646`、`backend/api/app/modules/content/publication.py:58-68`。

### 3.3 缺失

- Image、Gallery、Table、File、Audio、Video、Embed 等完整节点及其服务端 schema。
- 媒体资产表、文章引用关系、上传会话、进度、重试、替换、去重、孤儿清理和外部 URL 导入。
- 服务器 autosave、本地备份、恢复提示、`beforeunload` 和路由离开保护。
- 自动版本策略、版本保留策略和结构化 diff。
- SEO 字段编辑、逐项检查、加权评分和桌面/移动 SERP 预览。
- 编辑者、审核者、发布者职责分离；审核任务、退回后重提、编辑锁和完整审计日志。
- 未发布草稿预览、定时发布、更新既有远端文章、媒体同步与远端资源映射。
- AI 选区改写、流式候选、接受/拒绝和 AI 操作审计。

## 四、成熟度矩阵

状态含义：`已实现` 表示关键业务闭环已存在；`部分` 表示只有骨架或单点能力；`缺失` 表示没有可用闭环。

| 能力 | 主要源码参考 | 当前状态 | 关键缺口 |
| --- | --- | --- | --- |
| 文档 schema 和结构化节点 | TipTap、Koenig | 部分 | 仅基础文本，缺媒体/表格/嵌入节点和 schema 迁移 |
| 媒体资产生命周期 | Koenig、Gutenberg | 缺失 | 没有资产模型、引用关系、去重和清理 |
| 上传、进度、失败、重试、替换 | Koenig、Novel、Gutenberg | 缺失 | TipTap 无宿主上传实现 |
| dirty、服务器 autosave | Gutenberg、Ghost、WordPress | 部分 | 有 dirty 和手动保存，无 autosave |
| 本地备份、恢复、离开保护 | Gutenberg、Ghost | 缺失 | 刷新、崩溃或离开可能丢未保存内容 |
| 手动/自动版本与恢复 | WordPress、Ghost | 部分 | 有手动永久版本，无自动版本及保留策略 |
| 结构化 diff | Wagtail/WordPress 的 revision 边界 | 部分 | 当前是 Markdown 行级 diff |
| SEO 字段和分析 | Rank Math | 部分 | 字段不可完整编辑，无检查项、权重和 SERP 预览 |
| 编辑/审核/发布角色 | Wagtail | 缺失 | 所有操作共用 `content:write` |
| 审核任务、退回、重提、锁 | Wagtail | 部分 | 有单次决定，无任务流、锁和角色队列 |
| 草稿预览 | Gutenberg | 缺失 | 无预览快照和受控预览 URL |
| 即时/定时/更新发布 | Ghost、Wagtail、WordPress | 部分 | 只有即时新建文章 |
| 发布媒体同步与去重 | Gutenberg、WordPress | 缺失 | 只调用 posts API，不调用 media API |
| AI 选区改写和审计 | Novel | 缺失 | 无选区命令、候选状态、接受/拒绝和审计 |

## 五、逐功能源码审计与完整改造范围

### 5.1 文档 schema 与结构化节点

**参考项目和真实源码**

- TipTap 图片节点定义 `src/alt/title/width/height`，`setImage` 最终只是 `insertContent`：`tiptap/packages/extension-image/src/image.ts:94-120`、`tiptap/packages/extension-image/src/image.ts:292-301`。
- TipTap 表格扩展提供插入表格、增删行列、合并拆分单元格和表头切换：`tiptap/packages/extension-table/src/table/table.ts:418-508`。
- TipTap 链接扩展实现协议校验、set/toggle/unset、autolink 和 paste handler：`tiptap/packages/extension-link/src/link.ts:176-213`、`tiptap/packages/extension-link/src/link.ts:381-428`、`tiptap/packages/extension-link/src/link.ts:514-551`。
- TipTap 音频扩展定义音频属性、插入命令和安全渲染：`tiptap/packages/extension-audio/src/audio.ts:120-174`、`tiptap/packages/extension-audio/src/audio.ts:195-207`、`tiptap/packages/extension-audio/src/audio.ts:228-248`。
- Koenig 为 Image、Gallery、Bookmark、Video、Audio、File 分别定义 node 和序列化数据：`koenig/packages/kg-default-nodes/src/nodes/image/ImageNode.ts`、`koenig/packages/kg-default-nodes/src/nodes/gallery/GalleryNode.ts`、`koenig/packages/kg-default-nodes/src/nodes/bookmark/BookmarkNode.ts`、`koenig/packages/kg-default-nodes/src/nodes/video/VideoNode.ts`、`koenig/packages/kg-default-nodes/src/nodes/audio/AudioNode.ts`、`koenig/packages/kg-default-nodes/src/nodes/file/FileNode.ts`。

**成熟机制**

- 文章正文以带 `schema_version` 的规范 JSON 为事实源，HTML 和 Markdown 是可重新生成的派生格式。
- 每个 block 有稳定 `node_id`；媒体节点只引用 `asset_id`，同时保存 alt、caption、尺寸、展示样式等文章语义。
- 客户端和服务端共享节点类型、属性、嵌套约束及 URL 安全规则；未知版本不能静默丢字段。
- schema 升级使用显式迁移函数，并保留原版本快照，不能在读取时破坏性覆盖。

**不应照搬**

- 不更换 TipTap 为 Lexical；Koenig 的 Lexical node 只用于理解业务颗粒度。
- 首期不复制 Gutenberg 全部 block catalog，也不引入 CRDT 实时协作。

**当前状态**：部分实现。当前服务端 schema 会拒绝成熟编辑器需要的媒体和表格节点。

**完整改造范围**

- 数据：为文档增加 `schema_version`；节点至少覆盖 paragraph、heading、blockquote、ordered/bullet list、code block、horizontal rule、image、gallery、table、file、audio、video、embed；媒体节点引用资产 ID。
- API：保存时按版本验证；提供 schema capability；旧文档读取时执行可测试的非破坏迁移。
- 前端：按同一 schema 注册 TipTap extensions、命令、插入菜单、节点工具条和只读 renderer。
- 失败：不支持节点返回节点路径、类型和版本；迁移失败保留原始快照并阻止覆盖。
- 权限/审计：普通编辑只能改文档；高风险 embed 按允许域和权限校验；记录 schema 迁移事件。
- 测试：每种 node JSON round-trip、HTML/Markdown render、恶意 URL、未知字段、旧版本迁移和大文档边界。

### 5.2 媒体资产模型和生命周期

**参考项目和真实源码**

- Koenig 编辑器要求宿主注入 `fileUploader`，编辑器自身不决定存储后端：`koenig/packages/koenig-lexical/src/components/KoenigComposer.tsx:30-76`。
- Image/Gallery/Video/Audio/File 都有独立组件和上传逻辑，而不是把 URL 塞进裸 HTML：`koenig/packages/koenig-lexical/src/nodes/ImageNodeComponent.tsx:88-150`、`koenig/packages/koenig-lexical/src/nodes/GalleryNodeComponent.tsx:71-97`、`koenig/packages/koenig-lexical/src/nodes/VideoNodeComponent.tsx:32-119`、`koenig/packages/koenig-lexical/src/nodes/AudioNodeComponent.tsx:24-71`、`koenig/packages/koenig-lexical/src/nodes/FileNodeComponent.tsx:34-59`。
- Gutenberg 上传期间锁定发布，完成后解锁：`gutenberg/packages/editor/src/utils/media-upload/index.js:47-70`、`gutenberg/packages/editor/src/utils/media-upload/index.js:88`。

**成熟机制**

- 资产是独立领域对象，不是一个 URL 字符串。至少保存类型、MIME、大小、hash、存储键、公开 URL、尺寸、时长、处理状态、来源、创建人和时间。
- 文章通过 binding 引用资产；同一资产可被多个文章或多个节点复用。
- 生命周期包含 `pending -> uploading -> processing -> ready`，以及 `failed/quarantined/deleted`；只有 ready 资产可进入发布快照。
- 原图、优化图、缩略图和远端 WordPress media ID 必须可追踪映射。

**不应照搬**

- 不把 Ghost 专属 CDN 路径或 Lexical 数据结构写入本项目领域模型。
- 不允许前端把临时 object URL 持久化为文章正文。

**当前状态**：缺失。

**完整改造范围**

- 数据：新增 `content_assets`、`article_asset_bindings`、`asset_variants`；唯一约束覆盖 project + content hash，删除采用引用计数/软删除和延迟清理。
- API：创建上传、签名/接收、完成、查询状态、替换、删除和资产库选择；所有请求按 project 隔离。
- 前端：资产库、上传队列、节点内进度、失败原因、重试、替换、alt/caption 编辑和处理中状态。
- 失败：校验 MIME/大小/魔数；处理中失败可重试；保存前阻止临时 URL；删除被引用资产返回冲突。
- 权限/审计：上传、删除、复用和外部导入分开授权；记录 hash、来源 URL、操作者和替换关系。
- 测试：重复上传去重、并发完成、恶意文件、跨项目访问、孤儿清理、删除引用冲突和发布时非 ready 资产门禁。

### 5.3 上传、进度、重试、替换和外部 URL 导入

**参考项目和真实源码**

- TipTap FileHandler 只捕获 drop/paste、过滤 MIME 后回调宿主 `onDrop/onPaste`：`tiptap/packages/extension-file-handler/src/FileHandlePlugin.ts:17-85`。
- Koenig 图片先用 object URL 预览，再调用真实上传：`koenig/packages/koenig-lexical/src/utils/imageUploadHandler.ts:9-22`。
- Koenig 图库按文件批量上传并按文件名回填结果；视频分别上传视频、自动缩略图和自定义缩略图：`koenig/packages/koenig-lexical/src/nodes/GalleryNodeComponent.tsx:71-97`、`koenig/packages/koenig-lexical/src/nodes/VideoNodeComponent.tsx:32-119`。
- Novel 使用 decoration placeholder，成功替换节点，失败移除占位；同时处理粘贴和拖放：`novel/packages/headless/src/plugins/upload-images.tsx:64-109`、`novel/packages/headless/src/plugins/upload-images.tsx:116-137`。
- Gutenberg 把外部 URL 图片 sideload 到 `/wp/v2/media`：`gutenberg/packages/editor/src/utils/media-sideload-from-url/index.js:20-34`。

**成熟机制**

- 选择、粘贴和拖放进入同一上传队列，先插入带稳定 `upload_id` 的 placeholder，再异步绑定正式资产。
- 上传任务可显示字节进度、取消和重试；重试复用幂等键，避免创建重复资产。
- 替换资产保留节点位置、caption、alt 和布局；旧资产在无引用后才进入清理。
- 外部 URL 导入由服务端抓取，防 SSRF，并保存来源和版权/归属信息。

**当前状态**：缺失。TipTap 当前只注册 StarterKit 和 Link。

**完整改造范围**

- API 和状态：上传初始化返回 `upload_id/asset_id`；分片或直传完成后由服务端校验；外部导入有独立 job 和状态查询。
- 前端：统一队列覆盖选择/粘贴/拖放；页面刷新后恢复未完成任务；节点支持取消、重试、替换和移除。
- 失败：区分网络失败、格式失败、大小失败、处理失败和安全拒绝；失败节点不能序列化为可发布内容。
- 权限/审计：限制来源域、大小和媒体类型；审计导入 URL、最终重定向、hash 和操作者。
- 测试：断网重试、重复提交、取消、刷新恢复、多文件部分失败、同名文件、SSRF、重定向和超大文件。

### 5.4 dirty、服务器 autosave、本地备份、恢复提示和离开保护

**参考项目和真实源码**

- Gutenberg selector 区分 dirty、saving、autosaving 和 preview link：`gutenberg/packages/editor/src/store/selectors.js:81-94`、`gutenberg/packages/editor/src/store/selectors.js:731-825`。
- Gutenberg action 明确区分普通保存、`isAutosave`、`isPreview`，并可锁定保存：`gutenberg/packages/editor/src/store/actions.js:469-543`、`gutenberg/packages/editor/src/store/actions.js:660-680`。
- Gutenberg 本地备份写入正文、标题、摘要和 CRDT snapshot；容量不足时退化，并支持清理：`gutenberg/packages/editor/src/store/local-autosave.js:20-82`。
- WordPress autosave 有独立 REST controller、权限检查和创建逻辑：`wordpress-core/src/wp-includes/rest-api/endpoints/class-wp-rest-autosaves-controller.php:18-211`。
- Ghost localStorage 每分钟保存草稿，空间满时删除最旧版本重试，每篇保留最近 5 个：`ghost/apps/ember-admin/app/services/local-revisions.js:7-107`、`ghost/apps/ember-admin/app/services/local-revisions.js:258-270`。
- Ghost 注册 `beforeunload` 和统一 unsaved-changes 服务；离开前取消待处理 autosave 并强制完成一次保存：`ghost/apps/ember-admin/app/controllers/lexical-editor.js:1097-1112`、`ghost/apps/ember-admin/app/controllers/lexical-editor.js:1232-1248`。

**成熟机制**

- 三层可靠性：内存 dirty、服务器 autosave、本地恢复副本。手动保存和 autosave 的产品语义不同。
- 服务器 autosave 不推进正式审核版本、不让旧审核失效；手动保存才创建可审核版本。
- 本地副本按 article + user + project + base review version 隔离；打开文章时比较时间和内容 hash，提示恢复、查看差异或丢弃。
- 页面刷新和浏览器关闭用 `beforeunload`；应用内路由跳转用独立离开拦截。正在保存时等待有上限，超时保留本地副本。

**当前状态**：部分实现。已有 dirty 和手动保存，无服务器 autosave、本地备份和离开保护。

**完整改造范围**

- 数据：新增短期 `article_autosaves`，记录 base version、document hash、内容快照、作者和过期时间；不混入永久版本表。
- API：autosave 使用独立端点和幂等序号；服务器返回最新 autosave、冲突基线和保存时间；手动保存可从 autosave 提升。
- 前端：debounce + 最大间隔保存；状态区分未保存、正在自动保存、已自动保存、手动保存失败、本地已保护。
- 失败：网络离线写本地；401/403 停止重试；409 保留双方内容并进入冲突解决；配额满按策略清理。
- 权限/审计：autosave 只能由当前可编辑用户读写；正式审计不记录每次击键，只记录恢复、丢弃和提升。
- 测试：快速输入去抖、慢速持续输入最大间隔、并发标签页、断网、配额满、崩溃恢复、路由离开和手动保存与 autosave 竞态。

### 5.5 手动版本、自动版本、保留策略和恢复

**参考项目和真实源码**

- WordPress 只有修订字段变化才建版本，并按配置保留和清理：`wordpress-core/src/wp-includes/revision.php:130-258`、`wordpress-core/src/wp-includes/revision.php:812-840`。
- WordPress 创建 autosave、写 revision 和恢复 revision 是不同动作：`wordpress-core/src/wp-includes/revision.php:277-476`。
- Ghost 根据初始保存、发布、取消发布、强制保存、内容变化和时间间隔决定是否建版本，并按 `max_revisions` 截断：`ghost/ghost/core/core/server/lib/post-revisions.ts:53-107`。
- Wagtail Revision 保存完整快照，可覆盖临时 revision 或新建，并从 revision 发布：`wagtail/wagtail/models/revisions.py:89-204`、`wagtail/wagtail/models/revisions.py:384-441`。

**成熟机制**

- autosave 是短期恢复数据；manual/review/publish/restore 是永久业务版本，两者不能混为一张无边界历史列表。
- 永久版本包含正文、title、slug、SEO metadata、资产引用和发布相关快照；恢复总是创建新版本。
- 自动版本按内容变化 + 最小时间间隔生成，并有数量/时间保留策略；已发布、审核决定和恢复来源关联版本不可清理。

**当前状态**：部分实现。手动版本和非破坏恢复已完成，这是可继续扩展的正确基础。

**完整改造范围**

- 数据：扩展 version type 为 generated/manual_edit/auto_checkpoint/review_submitted/review_decision/restored/published；保存 schema version、content hash、asset manifest 和 metadata。
- API/前端：历史按永久版本与自动检查点分组；恢复前展示结构化差异；允许命名重要版本。
- 失败：版本写入和文章 current pointer 同事务；恢复资产不存在时阻止并给出清单。
- 权限/审计：编辑者可恢复未发布版本，发布后版本恢复需要更高权限；记录来源版本和原因。
- 测试：无变化不建版本、时间间隔、保留豁免、恢复链、并发恢复、资产引用和事务回滚。

### 5.6 block、inline 和 metadata 结构化 diff

**参考项目和真实源码**

- WordPress/Ghost/Wagtail 都以完整 revision 快照作为版本边界，而不是把 UI 文本行差异作为事实源。
- 当前产品 diff 位于 `backend/api/app/modules/content/service.py:825-901`，使用 Markdown 行级 `SequenceMatcher`。

**成熟机制**

- 先按稳定 `node_id` 匹配 block，再识别新增、删除、移动、类型变化和属性变化。
- 文本 block 内再做 inline diff，保留 bold/link 等 mark 变化；媒体节点比较 asset、alt、caption 和布局。
- title、slug、meta title、meta description、focus keyword、publication settings 作为 metadata diff 单独展示。
- diff 是派生结果，必要时可按算法版本重新计算；永久保存的是两个快照和审计事件。

**当前状态**：部分实现。可读文本差异存在，但不能支持成熟审核。

**完整改造范围**

- 服务端：实现 canonical document diff，输出 typed operations 和 summary；大文档异步计算并缓存算法版本。
- 前端：按正文、媒体、SEO、发布设置分组；支持定位到节点和接受审核时查看完整变化。
- 失败：旧 schema 无法迁移时回退到只读 JSON/文本 diff，并明确降级，不伪装成完整 diff。
- 权限/审计：敏感字段 diff 按权限裁剪；审核决定记录其查看的 from/to version。
- 测试：block move、mark change、图片替换、表格单元格、metadata、旧 schema 和性能上限。

### 5.7 SEO 字段、逐项检查、加权评分和 SERP 预览

**参考项目和真实源码**

- Rank Math `Assessor` 将 SERP title、slug、description、正文、关键词、Schema 和特色图装入 Paper，并对分析 debounce：`rank-math/assets/admin/src/sidebar/Assessor.js:69-103`。
- Analyzer 支持全量和部分分析：`rank-math/assets/admin/src/analyzer/Analyzer.js:38-71`。
- ResultManager 使用 `sum(score) / sum(maxScore) * 100` 聚合总分：`rank-math/assets/admin/src/analyzer/ResultManager.js:73-103`。
- 检查按 Basic SEO、Additional、Title Readability、Content Readability 分组并显示错误数：`rank-math/assets/admin/src/sidebar/components/General/CheckLists.js:89-125`、`rank-math/assets/admin/src/sidebar/components/General/CheckLists.js:240-320`。
- SERP 预览渲染 URL、标题和描述，支持关键词高亮、noindex 状态和桌面/移动切换：`rank-math/assets/admin/src/sidebar/components/Editor/SerpPreview.js:24-55`、`rank-math/assets/admin/src/sidebar/components/Editor/SerpPreview.js:168-257`、`rank-math/assets/admin/src/sidebar/components/Editor/PreviewDevices.js:13-38`。

**成熟机制**

- SEO 字段是可编辑文章元数据，保存和版本化，不是生成结果的只读附属信息。
- 每条检查有稳定 ID、分组、严重度、权重、最大分、证据和改进建议；主关键词和次关键词运行不同规则集。
- 总分是加权展示指标，不等于发布硬门禁。事实错误、缺少必要字段等质量门禁与 SEO 建议分开。
- SERP 预览使用最终 canonical URL 规则、像素/字符截断近似和桌面/移动模式；明确它是模拟，不冒充 Google 实际结果。

**不应照搬**

- 不把英语文化强绑定的情绪词、power words 等规则直接变成中文内容的发布硬门禁。
- 不复制 Rank Math 的 WordPress store 结构；只参考分析契约和交互颗粒度。

**当前状态**：部分实现。

**完整改造范围**

- 数据/API：保存 focus/secondary keywords、slug、meta title/description、canonical 和 index setting；分析响应包含规则版本、逐项结果、权重和总分。
- 前端：编辑字段、长度反馈、逐项检查、证据定位、重新分析、桌面/移动 SERP 预览；正文变化只重跑相关规则。
- 失败：分析服务失败不丢编辑内容；显示上次成功版本和过期状态；规则版本变化可重算。
- 权限/审计：编辑 SEO 字段属于编辑权限，index/canonical 可设更高权限；记录规则版本和发布时快照。
- 测试：权重边界、主次关键词差异、中文字符、空字段、noindex、URL 截断、过期分析和“SEO 低分不误阻发布”。

### 5.8 编辑者、审核者和发布者角色

**参考项目和真实源码**

- Wagtail GroupApprovalTask 把审核能力分配给指定组：`wagtail/wagtail/models/workflows.py:791-897`。
- Wagtail TaskState 将任务状态与执行人、时间、评论和 revision 绑定：`wagtail/wagtail/models/workflows.py:942-1062`。
- 当前产品审核、恢复和发布都使用同一个 `content:write`：`backend/api/app/api/routes/content.py:421-602`。

**成熟机制**

- 权限至少拆分为 `content:edit`、`content:submit_review`、`content:review`、`content:publish`、`content:manage_assets`。
- 服务端逐动作授权，前端隐藏按钮只是体验，不是安全边界。
- 默认阻止作者审核自己的文章；确需允许时由项目策略显式开启并记录。
- 发布者只能发布已批准且版本一致的快照，不能绕过审核去发布当前草稿。

**当前状态**：缺失。现有 `content:write` 无法形成职责分离。

**完整改造范围**

- 数据：项目角色/权限策略和文章参与人；发布策略记录是否允许自审、是否要求双人审核。
- API/前端：所有动作独立权限；工作区根据权限呈现编辑、提交、审核和发布视图。
- 失败：权限变更即时生效；操作执行中被撤权时服务端拒绝且不改变状态。
- 审计：记录 actor、effective role、policy version 和拒绝原因。
- 测试：权限矩阵、自审限制、跨项目、撤权竞态、直接调用 API 绕过 UI。

### 5.9 审核任务、退回、重提、锁和审计日志

**参考项目和真实源码**

- Wagtail WorkflowState 有 in progress、approved、needs changes、cancelled，并在退回后恢复流程：`wagtail/wagtail/models/workflows.py:100-137`、`wagtail/wagtail/models/workflows.py:202-301`。
- TaskState approve/reject 记录用户、时间、评论并触发状态更新和日志：`wagtail/wagtail/models/workflows.py:1023-1062`。
- BasicLock、WorkflowLock 和 ScheduledForPublishLock 分开表达锁原因：`wagtail/wagtail/locks.py:73-260`；锁保存 `locked_at/locked_by`：`wagtail/wagtail/models/locking.py:15-27`。
- ModelLogEntry 提供统一 `log_action`：`wagtail/wagtail/models/audit_log.py:132`、`wagtail/wagtail/models/audit_log.py:348`。

**成熟机制**

- “提交审核”创建绑定 revision 的任务；审核者审批或退回；编辑后必须重提新 revision，旧决定不可继承。
- 审核任务和文章当前状态分开保存，保留每一次提交、领取、评论、决定、取消和重提。
- 锁有原因、持有人、过期时间和管理员解锁；审核/定时发布锁与普通编辑锁语义不同。
- 审计日志 append-only，包含 before/after 状态、revision、actor、时间、请求关联 ID 和说明。

**不应照搬**

- 首期不实现 Wagtail 可配置任意模型、任意多步骤工作流的全部复杂度。先固定文章的一阶段审核流程，但领域模型要能保留任务历史。

**当前状态**：部分实现。已有版本绑定决定，但没有任务、重提队列、锁和统一审计。

**完整改造范围**

- 数据：`article_review_tasks`、`article_locks`、`content_audit_events`；任务绑定 immutable version。
- API/前端：提交、领取/分配、审批、退回、取消、重提、评论、锁续期/释放；审核收件箱和只读 diff。
- 失败：重复决定幂等；过期锁可恢复；stale version 返回当前版本和任务状态；管理员解锁有理由。
- 权限/审计：审核者不能改被审快照；每次状态转换均写审计，同事务提交。
- 测试：退回重提、并发审核、过期锁、管理员解锁、旧任务决定、评论必填策略和审计完整性。

### 5.10 草稿预览

**参考项目和真实源码**

- Gutenberg 同步打开/复用预览标签页，再异步保存后跳转，避免浏览器拦截弹窗：`gutenberg/packages/editor/src/components/post-preview-button/index.js:192-214`。
- Gutenberg 优先使用 autosave preview URL，让未正式保存的修改可预览：`gutenberg/packages/editor/src/components/post-preview-button/index.js:219-222`。
- action 用 `isPreview` 区分预览保存：`gutenberg/packages/editor/src/store/actions.js:541-543`。

**成熟机制**

- 预览基于不可变 preview snapshot，不读取不断变化的当前草稿。
- 预览 URL 是短期签名地址，绑定 project、article、version/snapshot、用户和过期时间；默认禁止索引。
- 预览 renderer 使用目标站主题/模板和最终资产 URL 规则；桌面/移动视口只是入口，不改变内容快照。

**当前状态**：缺失。

**完整改造范围**

- 数据/API：创建 preview snapshot 和短期 token；可选择当前 autosave 或已保存 version；撤销和过期。
- 前端：同步打开窗口，显示生成中间页，快照创建后跳转；明确预览版本和过期时间。
- 失败：弹窗被阻止、快照失败、资产未 ready 和 token 过期均有可重试状态。
- 权限/审计：只有文章参与者创建预览；记录创建和访问，不把 token 写日志。
- 测试：未保存内容、已发布文章改稿、过期/撤销、跨项目 token、noindex 和弹窗流程。

### 5.11 即时发布、定时发布、更新远端文章和状态机

**参考项目和真实源码**

- Ghost 明确定义 published/draft/scheduled/sent 状态，并校验调度时间和临近发布时间：`ghost/ghost/core/core/server/models/post.js:40`、`ghost/ghost/core/core/server/models/post.js:552-602`。
- Wagtail revision 有 `approved_go_live_at`，草稿模型有 `go_live_at/expire_at`：`wagtail/wagtail/models/revisions.py:89-113`、`wagtail/wagtail/models/draft_state.py:35-38`。
- Wagtail 调度命令处理到期下线和到期 revision 发布，并写 `wagtail.publish.scheduled`：`wagtail/wagtail/management/commands/publish_scheduled.py:49-120`。
- 当前产品发布调用固定 `/wp-json/wp/v2/posts`：`backend/api/app/modules/content/publication.py:58-68`。

**成熟机制**

- 发布命令绑定 approved version、target 和 idempotency key；远端结果不能反向改变已审核快照。
- 状态至少包含 queued/submitting/published/failed/uncertain/cancelled；定时发布另有 scheduled/cancelling 状态和持久任务。
- 首次发布使用 POST；已有 remote post ID 时使用更新接口。失败可区分确定失败和响应不确定，后者先查询远端再允许重试。
- 调度执行再次检查权限策略、批准版本、资产状态和目标连接；更新草稿后原调度版本不静默改变。

**不应照搬**

- 不引入 Ghost newsletter、membership、email-only 和 sent 业务状态。

**当前状态**：部分实现。即时发布幂等和 uncertain 治理基础正确，但无调度与更新远端文章。

**完整改造范围**

- 数据：发布 target、远端 post ID、published version、schedule、attempt 和状态转换时间。
- API/worker：创建/取消调度、立即发布、更新、查询远端校准；任务由持久队列执行并支持租约。
- 前端：发布面板区分立即/定时、目标、当前远端状态、最近尝试和不确定状态处置。
- 失败：超时后 reconcile；重复 worker 依赖幂等；连接失效不丢调度；时区和夏令时保存为 UTC + 原时区。
- 权限/审计：只有发布者创建/取消调度；记录发布版本、目标、请求 hash、远端 ID 和状态转换。
- 测试：首次发布、更新、双击、worker 重跑、超时不确定、取消竞态、到期执行、连接撤销和时区。

### 5.12 WordPress 媒体同步、去重和发布快照

**参考项目和真实源码**

- Gutenberg 媒体上传封装在宿主 media utility，并在上传期间锁定发布：`gutenberg/packages/editor/src/utils/media-upload/index.js:15-88`。
- Gutenberg 外部媒体导入调用 WordPress `/wp/v2/media`：`gutenberg/packages/editor/src/utils/media-sideload-from-url/index.js:20-34`。
- 当前产品没有 media endpoint，只向 posts endpoint 发送正文和少量字段。

**成熟机制**

- 发布前冻结 asset manifest；逐个查找本地 asset + target 到远端 media ID 的映射。
- 已映射且 hash 一致则复用；未映射则上传；资产被替换或内容 hash 变化才创建/更新远端媒体。
- WordPress 返回的 source URL 回填到“发布渲染结果”，不修改编辑文档中的本地 asset ID。
- 文章创建/更新必须在所需媒体全部成功后进行；失败重试复用已完成映射。

**当前状态**：缺失。

**完整改造范围**

- 数据：`publication_asset_mappings(target_id, asset_id, remote_media_id, source_url, hash)` 和发布 manifest。
- API/worker：上传 media、设置 alt/caption、查询现有映射、生成目标 HTML，再创建/更新 post。
- 前端：发布检查显示待同步/已同步/失败媒体，并可定位原节点。
- 失败：部分媒体成功后保存 checkpoint；远端删除后重建映射；同 hash 并发上传用唯一约束收敛。
- 权限/审计：发布 worker 使用目标连接密钥；日志脱敏；记录远端 media ID 和 hash。
- 测试：重复发布去重、部分失败续跑、远端删除、图片替换、alt 更新、并发发布和 HTML URL 替换。

### 5.13 AI 选区改写、流式候选、接受/拒绝和审计

**参考项目和真实源码**

- Novel `AISelector` 获取选区内容、添加高亮、调用 `useCompletion` 并显示 loading/流式结果：`novel/apps/web/components/tailwind/generative/ai-selector.tsx:29-105`。
- 命令区分编辑/审查选区和续写：`novel/apps/web/components/tailwind/generative/ai-selector-commands.tsx:37-66`。
- 完成结果可替换选区或在选区后插入：`novel/apps/web/components/tailwind/generative/ai-completion-command.tsx:18-46`。
- 服务端使用 `streamText`：`novel/apps/web/app/api/generate/route.ts:118`；AI highlight 是独立 mark 和命令：`novel/packages/headless/src/extensions/ai-highlight.ts:29-122`。

**成熟机制**

- 请求固定 base review version、selection bookmark、选中文本 hash、命令类型、上下文和 prompt version。
- 流式输出先进入候选层，不直接改正文；用户接受后用单个编辑 transaction 替换/插入，拒绝则正文不变。
- 接受前检查选区仍与原 hash 一致；否则要求重新选择，避免覆盖用户后续编辑。
- 接受操作进入文档历史和审计，可撤销；模型调用保存 provider/model、token、延迟、结果 hash，不保存密钥。

**不应照搬**

- 不照搬 Novel 演示限流、通用 prompt 和无业务权限的 API route。
- 不允许 AI 自动接受结果、自动提交审核或绕过质量门禁。

**当前状态**：缺失。

**完整改造范围**

- 数据/API：`ai_edit_operations` 保存命令、基线、选区 hash、状态 streamed/accepted/rejected/failed 和审计元数据；支持取消流。
- 前端：选区浮层、命令菜单、流式候选、接受/替换、插入、拒绝、重试和撤销；候选不污染保存状态。
- 失败：流中断保留可重试状态；stale selection 禁止应用；内容安全拒绝给出明确状态。
- 权限/审计：AI 使用独立权限和配额；敏感上下文按项目策略裁剪；接受者与调用者都记录。
- 测试：选区漂移、流取消、重复接受、撤销、超时、权限、审计、prompt 注入边界和长文本。

### 5.14 TipTap 的职责边界

TipTap 不能被当成完整文章业务项目。源码已经清楚说明其边界：

- Image 的 `setImage` 只插入节点，不上传文件。
- FileHandler 只把 drop/paste 文件交给宿主回调。
- Table、Link、Audio 提供节点、命令和渲染，不提供资产、版本或发布。
- TipTap 不提供 autosave、revision、workflow、preview、publishing 和 audit log。

因此正确方向是继续使用 TipTap，扩充 extension 与服务端 schema，并在编辑器外建立文章生产领域服务。更换编辑器既不能自动补齐这些业务，还会破坏当前已完成的文档、版本和工作区基础。

## 六、完整分阶段范围

阶段不是按钮清单。每一阶段只有在数据、API、前端、状态、失败、权限、审计和测试同时达到验收后才算完成。

### P0：文档 schema 与媒体资产基础

- 数据：schema version、稳定 node ID、资产/variant/binding 表、hash 去重和引用生命周期。
- API：文档 capability、schema 校验/迁移、资产创建/查询/删除和项目隔离。
- 前端：注册目标节点但先以受控只读/插入能力逐个开放；资产库基础。
- 状态/失败：资产状态机、未知 schema、迁移失败和被引用删除冲突。
- 权限/审计：资产管理权限、schema migration 和资产操作事件。
- 测试：全节点 round-trip、迁移、安全 URL、去重、跨项目和生命周期。

### P1：可靠保存、服务器 autosave、本地恢复和离开保护

- 数据/API：短期 autosave、base version、内容 hash、过期和提升为手动版本。
- 前端：debounce/max interval、保存状态、本地副本、恢复 diff 和离开拦截。
- 状态/失败：离线、409 并发、401 停止重试、localStorage 配额和保存竞态。
- 权限/审计：用户隔离；恢复/丢弃/提升事件。
- 测试：断网、刷新、崩溃、多标签页、持续输入和离开流程。

### P2：编辑器节点和上传全链路

- 数据/API：上传会话、处理任务、外部导入和替换关系。
- 前端：Image/Gallery/Table/File/Audio/Video、粘贴/拖放、进度、取消、重试和替换。
- 状态/失败：placeholder 不入正式文档、上传恢复、部分失败和安全拒绝。
- 权限/审计：MIME/大小/来源策略和上传审计。
- 测试：节点操作、上传竞态、刷新恢复、SSRF、恶意文件和发布门禁。

### P3：SEO 编辑、逐项分析、加权评分和 SERP 预览

- 数据/API：完整 SEO 元数据、规则/权重版本和结构化结果。
- 前端：字段编辑、分组检查、证据定位、主次关键词和桌面/移动预览。
- 状态/失败：debounce 部分重算、旧结果标记、服务失败降级。
- 权限/审计：canonical/index 设置权限和发布快照。
- 测试：规则、权重、中文、截断、noindex 和门禁边界。

### P4：结构化 diff、角色权限、审核任务和锁

- 数据/API：typed diff、角色策略、review task、lock 和 audit event。
- 前端：提交/审核队列、版本差异、退回重提、锁状态和管理员处置。
- 状态/失败：并发审核、旧版本、锁过期、重复决定和恢复。
- 权限/审计：编辑/提交/审核/发布分离、自审策略和 append-only 日志。
- 测试：完整权限矩阵、任务状态机、结构化 diff 和并发。

### P5：预览、定时发布、媒体同步/去重和发布状态机

- 数据/API：preview snapshot/token、target、schedule、attempt、remote post/media mapping。
- 前端：草稿预览、立即/定时发布、远端状态和不确定状态处置。
- 状态/失败：持久任务、租约、幂等、reconcile、取消竞态和媒体 checkpoint。
- 权限/审计：发布者权限、token 保护、目标连接脱敏和完整发布事件。
- 测试：预览安全、首次/更新/定时发布、超时、重跑、时区和媒体去重。

### P6：AI 选区改写、流式候选、接受/拒绝和版本审计

- 数据/API：AI operation、selection hash、prompt/model version、流取消和操作状态。
- 前端：选区命令、流式候选、接受/拒绝/重试/撤销。
- 状态/失败：stale selection、流中断、重复接受和安全拒绝。
- 权限/审计：AI 权限、配额、上下文策略和接受事件。
- 测试：流式状态、选区漂移、撤销、权限、审计和长文本。

## 七、范围分类

### 7.1 必须首期实现

这里的“首期”指继续扩充编辑器前必须先打牢的 P0-P2，不是缩减版 UI：

- 带版本的规范文档 schema 和服务端/前端一致验证。
- 独立媒体资产模型、文章引用、上传状态、去重和安全校验。
- 服务器 autosave、本地恢复、离开保护和与手动版本明确分离。
- Image、Gallery、Table、File 的完整插入、编辑、上传、失败和恢复；Audio/Video 如产品允许插入则同样完成全链路，不能只渲染 URL。
- 永久版本继续保持不可覆盖恢复，并补齐正文以外的 metadata 和 asset manifest。

### 7.2 成熟产品后续必须补齐

- P3 SEO 编辑和分析全套。
- P4 结构化 diff、角色、任务、锁和审计。
- P5 安全预览、定时/更新发布、WordPress 媒体同步和状态机。
- P6 AI 选区候选和可追踪接受流程。

这些可以按阶段排期，但不能从最终成熟范围中删除。

### 7.3 不适合当前 SEO SaaS 照搬

- Ghost newsletter、membership、email-only 和 `sent` 状态。
- Wagtail 面向任意模型的通用多步骤 workflow 配置复杂度。
- Gutenberg 全部 block catalog 和首期 CRDT 实时协作。
- Rank Math 情绪词、power words 等英语文化强绑定规则作为发布硬门禁。
- Novel 示例中的演示限流、通用 prompt 和缺少业务权限的 API。
- Koenig 的 Lexical 运行时和 Ghost 专属 URL/CDN 约定。

## 八、整体验收标准

完成后的文章生产板块至少满足以下可验证结果：

1. 支持的每种结构化节点都能在 TipTap 编辑、服务端校验、保存、恢复、预览和 WordPress 发布之间无损 round-trip。
2. 任何本地临时 URL、上传 placeholder、failed/processing 资产都不能进入可发布版本。
3. 浏览器刷新、崩溃、断网和应用内离开不会静默丢失内容；恢复副本会明确提示来源和差异。
4. autosave 不推进审核版本；手动保存、提交审核、恢复和发布都有明确版本语义。
5. 版本差异能区分 block 移动、inline mark、媒体属性和 SEO metadata，而不只是 Markdown 行变化。
6. SEO 每项结果有规则 ID、证据、权重和版本；总分可解释，低分本身不会错误阻止发布。
7. 编辑者不能调用审核/发布 API；审核者不能审批已变化的旧版本；发布者只能发布批准快照。
8. 审核的提交、领取、退回、重提、审批、锁和管理员操作均可从 append-only 日志还原。
9. 草稿预览使用短期签名快照，跨项目不可访问，并明确 noindex。
10. 首次发布、更新远端文章、定时发布、重试和超时不确定状态都通过持久状态机处理。
11. WordPress 媒体按资产和目标去重；部分成功后重试不会重复上传已完成媒体。
12. AI 流式结果在接受前不改变正文；选区漂移时禁止应用；接受/拒绝可审计，接受后可撤销。
13. 所有关键能力都有 API 集成测试、领域状态机测试和浏览器端用户流程测试，不以组件存在代替闭环验收。

## 九、最终采用方式

后续实现应按以下架构边界执行：

```text
TipTap 编辑内核
  -> 版本化 ArticleDocument schema
  -> ContentAsset / 上传与处理服务
  -> Autosave / Revision / Diff 服务
  -> SEO Analysis 服务
  -> Review Task / Permission / Audit 服务
  -> Preview Snapshot 服务
  -> Publication Orchestrator / WordPress Adapter
  -> AI Edit Operation 服务
```

这套方式保留当前 TipTap 和已完成的文章版本/发布治理基础，同时把成熟开源项目的业务机制对齐到本项目领域。实现时可以复用思路和测试边界，但不能直接复制 Ghost/Wagtail/WordPress 的框架耦合代码，也不能把演示项目的组件当成完成的生产能力。
