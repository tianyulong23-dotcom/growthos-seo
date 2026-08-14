import type { Editor } from "@tiptap/core"

import type { ArticleDocumentCapabilities } from "@/api/articles"

export type ArticleEditorPhase = "P2" | "P3" | "P6"
export type ArticleEditorCommandGroup =
  "text" | "media" | "structure" | "enhanced"

export type ArticleEditorCommandId =
  | "paragraph"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6"
  | "bulletList"
  | "orderedList"
  | "blockquote"
  | "codeBlock"
  | "horizontalRule"
  | "image"
  | "gallery"
  | "table"
  | "file"
  | "audio"
  | "video"
  | "callout"
  | "details"
  | "bookmark"
  | "button"
  | "embed"

export type ArticleEditorCommand = {
  id: ArticleEditorCommandId
  label: string
  aliases: string[]
  group: ArticleEditorCommandGroup
  phase: ArticleEditorPhase
  node: string
  media?: boolean
  enhanced?: boolean
  run: (editor: Editor) => boolean
}

export type ArticleEditorMediaCommandHandler = (
  id: Extract<
    ArticleEditorCommandId,
    "image" | "gallery" | "file" | "audio" | "video"
  >
) => void

export type ArticleEditorEnhancedCommandHandler = (
  id: Extract<ArticleEditorCommandId, "bookmark" | "button" | "embed">
) => void

const phaseRank: Record<ArticleEditorPhase, number> = { P2: 2, P3: 3, P6: 6 }

export const articleEditorCommands: ArticleEditorCommand[] = [
  {
    id: "paragraph",
    label: "正文",
    aliases: ["paragraph", "text"],
    group: "text",
    phase: "P2",
    node: "paragraph",
    run: (editor) => editor.chain().focus().setParagraph().run(),
  },
  ...([2, 3, 4, 5, 6] as const).map((level): ArticleEditorCommand => ({
    id: `heading${level}`,
    label: `${level} 级标题`,
    aliases: [`h${level}`, `heading ${level}`, `标题${level}`],
    group: "text",
    phase: "P2",
    node: "heading",
    run: (editor) => editor.chain().focus().toggleHeading({ level }).run(),
  })),
  {
    id: "bulletList",
    label: "无序列表",
    aliases: ["bullet list", "ul"],
    group: "text",
    phase: "P2",
    node: "bulletList",
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    id: "orderedList",
    label: "有序列表",
    aliases: ["ordered list", "ol"],
    group: "text",
    phase: "P2",
    node: "orderedList",
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "blockquote",
    label: "引用",
    aliases: ["quote", "blockquote"],
    group: "text",
    phase: "P2",
    node: "blockquote",
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "codeBlock",
    label: "代码块",
    aliases: ["code block", "pre"],
    group: "text",
    phase: "P2",
    node: "codeBlock",
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: "horizontalRule",
    label: "分隔线",
    aliases: ["divider", "rule", "hr"],
    group: "structure",
    phase: "P2",
    node: "horizontalRule",
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    id: "image",
    label: "图片",
    aliases: ["image", "photo"],
    group: "media",
    phase: "P2",
    node: "image",
    media: true,
    run: () => false,
  },
  {
    id: "gallery",
    label: "图库",
    aliases: ["gallery", "photos"],
    group: "media",
    phase: "P2",
    node: "gallery",
    media: true,
    run: () => false,
  },
  {
    id: "table",
    label: "表格",
    aliases: ["table", "excel"],
    group: "structure",
    phase: "P2",
    node: "table",
    run: () => false,
  },
  {
    id: "file",
    label: "文件",
    aliases: ["file", "download"],
    group: "media",
    phase: "P2",
    node: "file",
    media: true,
    run: () => false,
  },
  {
    id: "audio",
    label: "音频",
    aliases: ["audio", "sound"],
    group: "media",
    phase: "P2",
    node: "audio",
    media: true,
    run: () => false,
  },
  {
    id: "video",
    label: "视频",
    aliases: ["video", "movie"],
    group: "media",
    phase: "P2",
    node: "video",
    media: true,
    run: () => false,
  },
  {
    id: "callout",
    label: "提示框",
    aliases: ["callout", "notice"],
    group: "enhanced",
    phase: "P2",
    node: "callout",
    run: (editor) =>
      editor
        .chain()
        .focus()
        .insertContent({
          type: "callout",
          attrs: { tone: "note", icon: null },
          content: [{ type: "paragraph" }],
        })
        .run(),
  },
  {
    id: "details",
    label: "折叠内容",
    aliases: ["toggle", "faq", "details"],
    group: "enhanced",
    phase: "P2",
    node: "details",
    run: (editor) =>
      editor
        .chain()
        .focus()
        .insertContent({
          type: "details",
          attrs: { summary: "问题", open_by_default: false },
          content: [
            { type: "detailsContent", content: [{ type: "paragraph" }] },
          ],
        })
        .run(),
  },
  {
    id: "bookmark",
    label: "书签卡片",
    aliases: ["bookmark"],
    group: "enhanced",
    phase: "P3",
    node: "bookmark",
    enhanced: true,
    run: () => false,
  },
  {
    id: "button",
    label: "按钮",
    aliases: ["button", "cta"],
    group: "enhanced",
    phase: "P3",
    node: "button",
    enhanced: true,
    run: () => false,
  },
  {
    id: "embed",
    label: "嵌入内容",
    aliases: ["embed", "youtube"],
    group: "enhanced",
    phase: "P3",
    node: "embed",
    enhanced: true,
    run: () => false,
  },
]

export function availableArticleEditorCommands(
  capabilities: ArticleDocumentCapabilities,
  phase: ArticleEditorPhase
) {
  const nodes = new Set(capabilities.nodes)
  return articleEditorCommands.filter(
    (command) =>
      phaseRank[command.phase] <= phaseRank[phase] &&
      nodes.has(command.node) &&
      (!command.media || capabilities.media_upload_enabled)
  )
}

export function searchArticleEditorCommands(
  commands: ArticleEditorCommand[],
  query: string
) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return commands
  return commands.filter((command) =>
    [command.label, command.id, ...command.aliases].some((value) =>
      value.toLocaleLowerCase().includes(normalized)
    )
  )
}

export function executeArticleEditorCommand(
  editor: Editor,
  command: ArticleEditorCommand,
  onMedia: ArticleEditorMediaCommandHandler,
  onEnhanced?: ArticleEditorEnhancedCommandHandler
) {
  if (command.media) {
    onMedia(command.id as Parameters<ArticleEditorMediaCommandHandler>[0])
    return true
  }
  if (command.enhanced) {
    onEnhanced?.(
      command.id as Parameters<ArticleEditorEnhancedCommandHandler>[0]
    )
    return Boolean(onEnhanced)
  }
  return command.run(editor)
}
