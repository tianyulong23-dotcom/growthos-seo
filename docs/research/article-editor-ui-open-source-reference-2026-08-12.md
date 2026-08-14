# 文章编辑器 UI/UX 开源参考

日期：2026-08-12

## 结论

当前编辑器的问题不是缺少 TipTap 或 shadcn/ui，而是页面组织方式仍然接近一个功能密集的后台表单：格式工具、正文、元数据、SEO、审核、版本和发布操作同时争夺注意力。

不建议整体复制某一个开源项目。最适合当前技术约束的组合是：

1. 以 **Minimal Tiptap** 作为 TipTap + shadcn/ui 的组件实现参考。
2. 以 **TipTap 官方 Simple Editor** 作为正文宽度、工具分组和响应式行为的基线。
3. 从 **Novel** 借鉴斜杠菜单、选区浮动工具和 AI 选区编辑。
4. 从 **Ghost Koenig** 借鉴媒体卡片、上传中、失败和替换状态。
5. 从 **Gutenberg** 借鉴顶部文档栏、按需打开的检查器侧栏和渐进披露。

固定约束保持不变：

- 富文本引擎继续使用 TipTap。
- TipTap 编辑内容以外的按钮、菜单、弹窗、抽屉、标签页、提示和表单控件全部使用项目内 shadcn/ui 组件。
- 不替换现有文档模型，不引入第二套编辑器引擎。

## 当前 UI 的主要问题

当前代码已经包含 TipTap 的 `BubbleMenu`、拖拽手柄、斜杠命令、表格、链接和媒体能力，也使用了 shadcn/ui 的 `Button`、`DropdownMenu`、`Dialog`、`Sheet`、`Tabs`、`Popover` 等组件。

因此，继续增加 shadcn 组件不会自然改善体验。主要问题是：

- 页面第一印象是“管理文章”，不是“专注写文章”。
- 顶部格式栏长期展示过多按钮，常用操作与低频操作没有分层。
- 正文、文章元数据、SEO、审核、版本、素材和发布同时可见。
- 固定右侧治理面板持续压缩正文区域。
- 正文画布偏宽，长段落阅读和定位困难。
- 已有的选区菜单、斜杠菜单和块级操作被页面外围控件淹没。
- 桌面端的信息密度被直接带到小屏，缺少真正的渐进披露。

这属于布局、信息层级和操作时机问题，不是组件库选型问题。

## 参考项目排序

| 排名 | 项目 | 编辑器引擎 | UI 技术匹配 | 许可证 | 适合参考的部分 | 不应照搬的部分 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Minimal Tiptap | TipTap 3 | 高，明确面向 shadcn/ui | MIT | 工具栏分组、Toggle、Tooltip、Dropdown、Popover、Dialog、链接和图片交互 | 整个带边框的表单控件式外壳 |
| 2 | TipTap Official UI Components | TipTap | 中，交互可复用但 UI primitives 不是 shadcn | MIT | 窄正文画布、响应式工具栏、链接和高亮流程 | 官方自有 UI primitives |
| 3 | Novel | TipTap 2 | 中，Radix、cmdk 和 Tailwind 风格 | Apache-2.0 | Notion 式写作、斜杠菜单、选区 AI、图片占位和缩放 | 旧版 TipTap 代码和演示应用外壳 |
| 4 | Ghost Koenig | Lexical | 低，只看交互 | MIT | 图片、图库、视频、音频、嵌入、上传状态和卡片设置 | Lexical 节点和 Ghost 专属约定 |
| 5 | Gutenberg | 自有 block editor | 低，只看工作区 | GPL-2.0-or-later | 文档栏、上下文侧栏、更多菜单、渐进披露 | 源码、block 架构和完整 WordPress 工作流 |
| 6 | BlockNote | ProseMirror/TipTap 基础上的独立模型 | 中，有 shadcn 包 | MPL-2.0 为主 | 拖拽、斜杠菜单、选择菜单的视觉基准 | 编辑器和数据模型替换 |
| 7 | Plate | Slate/Plate | 高，shadcn 编辑器套件成熟 | MIT | 高级工具栏的分组和控件状态 | Slate/Plate 引擎和节点实现 |

## 1. Minimal Tiptap

- 仓库：[Aslam97/minimal-tiptap](https://github.com/Aslam97/minimal-tiptap)
- 审计版本：[`93b55598a206f809cd8d37a481d7391a829c6623`](https://github.com/Aslam97/minimal-tiptap/tree/93b55598a206f809cd8d37a481d7391a829c6623)
- 许可证：MIT

这是与当前约束最接近的代码参考：TipTap 3，并围绕 shadcn/ui 风格组织按钮、下拉菜单、弹出层、对话框、开关、提示和分隔线。

应借鉴：

- 用 `Toggle` 表达粗体、斜体、删除线等可保持状态的命令。
- 用 `Tooltip` 说明图标按钮，不在工具栏堆放解释文字。
- 把低频格式放进 `DropdownMenu`，只保留最常用操作。
- 链接、图片和代码使用独立的上下文交互。
- 窄屏时把工具组收进溢出菜单。

不应直接复制其整个编辑器边框。当前产品需要全页写作工作区，不是嵌在表单里的富文本输入框。

## 2. TipTap 官方 Simple Editor

- 仓库：[ueberdosis/tiptap-ui-components](https://github.com/ueberdosis/tiptap-ui-components)
- 审计版本：[`799929bea4804c73767562b69f8acc2acdb8ac86`](https://github.com/ueberdosis/tiptap-ui-components/tree/799929bea4804c73767562b69f8acc2acdb8ac86)
- 许可证：MIT

官方 Simple Editor 是最可靠的 TipTap 交互基线。其示例将正文写作宽度控制在约 `648px`，并对桌面和移动工具栏分别处理。

应借鉴：

- 正文列保持稳定的阅读宽度。
- 工具按内容类型分组，而不是平铺所有 extension 命令。
- 移动端工具栏可以切换子视图，而不是强行压缩全部按钮。
- 链接、高亮和图片各自拥有完整但简短的操作流程。

官方示例使用 TipTap 自有 UI primitives。这里只复制布局和交互规则，宿主控件仍要改用项目已有的 shadcn/ui 组件。

## 3. Novel

- 仓库：[steven-tey/novel](https://github.com/steven-tey/novel)
- 本地参考：`F:\seo-open-source-references\novel`
- 审计版本：[`fa95098e66476c466faebb8211baa5869c101a9c`](https://github.com/steven-tey/novel/tree/fa95098e66476c466faebb8211baa5869c101a9c)
- 许可证：Apache-2.0

Novel 最值得参考的是写作时机，而不是组件外观：未选中内容时保持安静，输入 `/` 时提供块命令，选中文字时才显示格式和 AI 操作。

应借鉴：

- 斜杠命令负责插入标题、列表、引用、图片和其他块。
- 选区 Bubble Menu 只显示与当前选择有关的命令。
- AI 改写围绕当前选区发生，并明确提供接受、替换或取消。
- 图片粘贴、拖放和上传共享占位状态，完成后替换为真实节点。

它基于 TipTap 2，且并非严格使用现代 shadcn/ui。应移植交互概念，不应直接搬运整套代码。

## 4. Ghost Koenig

- 仓库：[TryGhost/Koenig](https://github.com/TryGhost/Koenig)
- 本地参考：`F:\seo-open-source-references\koenig`
- 审计版本：[`4da831801b9ca065e4b30abe96c8b33227133e6c`](https://github.com/TryGhost/Koenig/tree/4da831801b9ca065e4b30abe96c8b33227133e6c)
- 许可证：MIT

Koenig 使用 Lexical，不适合作为代码底座，但它对媒体内容的状态设计比普通富文本示例完整。

应借鉴：

- 图片、图库、视频、音频、文件、书签和嵌入使用不同卡片交互。
- 上传中、处理、失败、重试、替换和删除都有可见状态。
- 卡片设置只在选中该卡片时出现。
- 媒体配置靠近内容本身，而不是长期占据全局侧栏。

所有这些状态应在现有 TipTap node view 中实现，宿主操作继续使用 shadcn/ui。

## 5. Gutenberg

- 仓库：[WordPress/gutenberg](https://github.com/WordPress/gutenberg)
- 本地参考：`F:\seo-open-source-references\gutenberg`
- 审计版本：[`c7cdb481578375c23863690bb07eab8f87c03762`](https://github.com/WordPress/gutenberg/tree/c7cdb481578375c23863690bb07eab8f87c03762)
- 许可证：GPL-2.0-or-later

Gutenberg 最有价值的是工作区层级，而不是它的 block engine。

应借鉴：

- 顶部文档栏只放返回、文档状态、预览、主操作和更多菜单。
- 全局设置与当前块设置在同一个检查器入口中按上下文切换。
- 右侧检查器默认可以关闭，关闭后正文回到页面视觉中心。
- 低频操作进入更多菜单，避免一直占用主工具栏。

只参考行为和信息架构，不复制 GPL 源码，也不引入 Gutenberg block 模型。

## 6. BlockNote 与 Plate

- BlockNote：[TypeCellOS/BlockNote](https://github.com/TypeCellOS/BlockNote/tree/e0cce104b525a778e7a38029f312430af60bc349)
- Plate：[udecode/plate](https://github.com/udecode/plate/tree/3add964236e300f93a0783f54395097e6bd28cb3)

这两个项目可以作为质量基准，但不应成为实现底座：BlockNote 会把产品带入另一套编辑器模型，Plate 使用 Slate/Plate 而不是 TipTap。

适合观察：

- 拖拽句柄和块插入器的位置与命中区域。
- 复杂工具栏如何分组、折叠和表达 active/disabled 状态。
- 表格、颜色、对齐和链接等高级控件如何避免撑乱布局。

## OpenSEO 是否有编辑器参考

本地 `E:\open-seo` 审计版本为 `bd402844fae9101da9591b8eb153871773eb3c27`。

未发现 TipTap、ProseMirror、Lexical、`contenteditable` 或产品级富文本编辑器实现。OpenSEO 可以参考 SEO 数据与工作流，但没有可供当前文章编辑器借鉴的 UI/UX 或代码底座。

## 推荐的新编辑器结构

### 顶部文档栏

使用安静、固定的单行文档栏：

- 返回文章库。
- 文章标题或状态摘要。
- 保存状态。
- 预览。
- 审核或发布主操作。
- 更多菜单。

主操作以外的按钮优先使用 Lucide 图标配 `Tooltip`。所有控件使用 shadcn/ui。

### 正文区域

- 正文建议控制在约 `680px` 至 `760px`，居中显示。
- 页面背景与正文区域保持克制，不把正文包进装饰性 Card。
- 标题、摘要和正文形成连续写作流，不让大量管理字段插入其间。
- 不保留一条包含所有命令的永久格式工具栏。

### 上下文格式操作

- 选中文字时显示 TipTap `BubbleMenu`。
- 空段落输入 `/` 时显示命令菜单。
- 块左侧显示拖拽手柄和插入入口。
- 选中表格时才显示表格工具。
- 选中媒体卡片时才显示替换、说明、对齐和删除操作。

菜单、弹出层、按钮和提示的外壳使用 shadcn/ui；TipTap 只负责编辑器状态、选区、命令和节点。

### SEO 与治理面板

- SEO、审核、版本、素材和发布设置默认不常驻正文旁边。
- 桌面端通过一个可开关的 inspector 展示。
- 小屏通过 shadcn `Sheet` 全屏或近全屏展示。
- 打开面板时保留当前分类，关闭后把注意力还给正文。
- 异常或阻塞项可在顶部显示简短状态，但详细内容进入对应面板。

## 实施优先级

### P0：先改变页面感受

1. 将正文宽度收窄并居中。
2. 把固定右栏改成默认关闭的检查器。
3. 精简顶部文档栏和永久工具栏。
4. 保留已有 TipTap 功能，不改文档 schema。

### P1：强化写作交互

1. 按 Minimal Tiptap 重组 shadcn 工具控件。
2. 让 Bubble Menu、斜杠菜单和块手柄成为主要格式入口。
3. 为桌面和移动端分别设计工具栏折叠行为。

### P2：完善内容块状态

1. 按 Koenig 的状态颗粒度完善图片和其他媒体卡片。
2. 只在相关节点被选中时显示配置。
3. 统一加载、失败、重试和替换交互。

## 验收标准

- 初次打开时，第一视觉焦点是文章正文，不是 SEO 或审核面板。
- 未选中内容时，不显示与当前任务无关的格式操作。
- 桌面正文保持稳定阅读宽度，侧栏关闭后正文处于视觉中心。
- 移动端没有横向溢出，低频命令进入菜单或 Sheet。
- 除 TipTap 编辑器能力外，宿主 UI 不新增自制按钮、菜单、弹窗或抽屉。
- 所有图标按钮都有可访问名称和 Tooltip，active、disabled、loading 状态清晰。
- 不改变现有正文文档格式、保存契约、前端端口或发布业务。
