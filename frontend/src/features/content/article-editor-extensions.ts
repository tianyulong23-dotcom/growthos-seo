import { Extension, Node } from "@tiptap/core"
import FileHandler from "@tiptap/extension-file-handler"
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import Link from "@tiptap/extension-link"
import { TableCell, TableHeader, TableKit } from "@tiptap/extension-table"
import TextAlign from "@tiptap/extension-text-align"
import Underline from "@tiptap/extension-underline"
import { CharacterCount, Placeholder } from "@tiptap/extensions"
import Highlight from "@tiptap/extension-highlight"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import StarterKit from "@tiptap/starter-kit"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { common, createLowlight } from "lowlight"
import type { ComponentType } from "react"
import type { ReactNodeViewProps } from "@tiptap/react"

import { ArticleAssetAccessStore } from "@/features/content/article-asset-access"
import { ArticleAIEditExtension } from "@/features/content/article-ai-edit-extension"
import {
  normalizeArticleCalloutIcon,
  normalizeArticleCalloutTone,
} from "@/features/content/article-callout"
import { ArticleCalloutNodeView } from "@/features/content/article-callout-nodeview"
import { ArticleCodeBlockNodeView } from "@/features/content/article-code-block-nodeview"
import { normalizeArticleDetailsSummary } from "@/features/content/article-details"
import { ArticleDetailsNodeView } from "@/features/content/article-details-nodeview"
import {
  ArticleBookmarkNodeView,
  ArticleButtonNodeView,
  ArticleEmbedNodeView,
  type ArticleEnhancedCardRuntimeStorage,
} from "@/features/content/article-enhanced-card-nodeviews"
import {
  reviewArticlePasteHtml,
  sanitizeArticlePasteHtml,
  type ArticlePasteReviewRequest,
} from "@/features/content/article-editor-paste"
import {
  ArticleAudioNodeView,
  ArticleFileNodeView,
  ArticleGalleryNodeView,
  ArticleImageNodeView,
  type ArticleMediaRuntimeStorage,
  ArticleVideoNodeView,
} from "@/features/content/article-media-nodeviews"
import {
  articleUploadPlaceholderPlugin,
  type ArticleUploadPlaceholderHandlers,
} from "@/features/content/article-upload-placeholder"

const NODE_ID_TYPES = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "image",
  "gallery",
  "table",
  "file",
  "audio",
  "video",
  "bookmark",
  "callout",
  "details",
  "button",
  "embed",
]

const ArticleDocumentAttributes = Extension.create({
  name: "articleDocumentAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["link"],
        attributes: {
          title: {
            default: null,
            parseHTML: (element) => element.getAttribute("title"),
          },
          link_kind: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-link-kind"),
            renderHTML: (attributes) =>
              typeof attributes.link_kind === "string"
                ? { "data-link-kind": attributes.link_kind }
                : {},
          },
        },
      },
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (element) => {
              const value = element.style.textAlign.toLowerCase()
              return ["left", "center", "right"].includes(value) ? value : null
            },
            renderHTML: (attributes) =>
              typeof attributes.textAlign === "string"
                ? { style: `text-align: ${attributes.textAlign}` }
                : {},
          },
          verticalAlign: {
            default: null,
            parseHTML: (element) => {
              const value = element.style.verticalAlign.toLowerCase()
              return ["top", "middle", "bottom"].includes(value) ? value : null
            },
            renderHTML: (attributes) =>
              typeof attributes.verticalAlign === "string"
                ? { style: `vertical-align: ${attributes.verticalAlign}` }
                : {},
          },
        },
      },
    ]
  },
})

const articleLowlight = createLowlight(common)
const articleCodeLowlight = {
  highlight: articleLowlight.highlight.bind(articleLowlight),
  highlightAuto: (value: string) =>
    articleLowlight.highlight("plaintext", value),
  listLanguages: articleLowlight.listLanguages.bind(articleLowlight),
  registered: articleLowlight.registered.bind(articleLowlight),
}

const ArticleCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ArticleCodeBlockNodeView)
  },
})

const ArticleTableCell = TableCell.extend({
  content: "paragraph+",
})

const ArticleTableHeader = TableHeader.extend({
  content: "paragraph+",
})

const ArticleNodeId = Extension.create({
  name: "articleNodeId",
  addGlobalAttributes() {
    return [
      {
        types: NODE_ID_TYPES,
        attributes: {
          node_id: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-node-id"),
            renderHTML: (attributes) =>
              typeof attributes.node_id === "string"
                ? { "data-node-id": attributes.node_id }
                : {},
          },
        },
      },
    ]
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("articleNodeId"),
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null
          }
          let transaction = newState.tr
          let changed = false
          const nodeIds = new Set<string>()
          newState.doc.descendants((node, position) => {
            if (!NODE_ID_TYPES.includes(node.type.name)) return
            const nodeId = node.attrs.node_id
            if (
              typeof nodeId === "string" &&
              nodeId &&
              !nodeIds.has(nodeId)
            ) {
              nodeIds.add(nodeId)
              return
            }
            let nextNodeId: string
            do {
              nextNodeId = `blk_${crypto.randomUUID().replaceAll("-", "")}`
            } while (nodeIds.has(nextNodeId))
            nodeIds.add(nextNodeId)
            transaction = transaction.setNodeMarkup(position, undefined, {
              ...node.attrs,
              node_id: nextNodeId,
            })
            changed = true
          })
          return changed ? transaction : null
        },
      }),
    ]
  },
})

type LeafNodeDefinition = {
  name: string
  attributes: string[]
  label: (attributes: Record<string, unknown>) => string
}

function readonlyLeafNode({ name, attributes, label }: LeafNodeDefinition) {
  return Node.create({
    name,
    group: "block",
    atom: true,
    selectable: true,
    defining: true,
    addAttributes() {
      return Object.fromEntries(
        attributes.map((attribute) => [attribute, { default: null }])
      )
    },
    parseHTML() {
      return [{ tag: `[data-article-node="${name}"]` }]
    },
    renderHTML({ node }) {
      return [
        "div",
        {
          "data-article-node": name,
          "data-node-id": node.attrs.node_id,
          class: "article-readonly-node",
          contenteditable: "false",
        },
        label(node.attrs),
      ]
    },
  })
}

function mediaLeafNode(
  definition: LeafNodeDefinition,
  nodeView: ComponentType<ReactNodeViewProps>
) {
  return readonlyLeafNode(definition).extend({
    addNodeView() {
      return ReactNodeViewRenderer(nodeView)
    },
  })
}

const ArticleImage = mediaLeafNode(
  {
    name: "image",
    attributes: [
      "asset_id",
      "alt",
      "decorative",
      "display",
      "caption",
      "link",
      "width",
      "height",
    ],
    label: (attrs) => `图片 · ${attrs.alt || attrs.asset_id}`,
  },
  ArticleImageNodeView
)

const ArticleGallery = mediaLeafNode(
  {
    name: "gallery",
    attributes: ["items", "display"],
    label: (attrs) =>
      `图库 · ${Array.isArray(attrs.items) ? attrs.items.length : 0} 项`,
  },
  ArticleGalleryNodeView
)

const ArticleFile = mediaLeafNode(
  {
    name: "file",
    attributes: ["asset_id", "display_name", "description"],
    label: (attrs) => `文件 · ${attrs.display_name || attrs.asset_id}`,
  },
  ArticleFileNodeView
)

const ArticleAudio = mediaLeafNode(
  {
    name: "audio",
    attributes: ["asset_id", "title", "caption", "duration_ms"],
    label: (attrs) => `音频 · ${attrs.title || attrs.asset_id}`,
  },
  ArticleAudioNodeView
)

const ArticleVideo = mediaLeafNode(
  {
    name: "video",
    attributes: [
      "asset_id",
      "title",
      "caption",
      "poster_asset_id",
      "duration_ms",
    ],
    label: (attrs) => `视频 · ${attrs.title || attrs.asset_id}`,
  },
  ArticleVideoNodeView
)

const ArticleBookmark = mediaLeafNode(
  {
    name: "bookmark",
    attributes: [
      "url",
      "title",
      "description",
      "thumbnail_asset_id",
      "publisher",
      "icon_url",
      "image_url",
      "fetched_at",
    ],
    label: (attrs) => `书签 · ${attrs.title || attrs.url}`,
  },
  ArticleBookmarkNodeView
)

const ArticleButton = mediaLeafNode(
  {
    name: "button",
    attributes: ["label", "href", "style", "target", "rel"],
    label: (attrs) => `按钮 · ${attrs.label || attrs.href}`,
  },
  ArticleButtonNodeView
)

const ArticleEmbed = mediaLeafNode(
  {
    name: "embed",
    attributes: ["provider", "source_url", "embed_id", "caption"],
    label: (attrs) => `嵌入内容 · ${attrs.provider || attrs.source_url}`,
  },
  ArticleEmbedNodeView
)

const ArticleCallout = Node.create({
  name: "callout",
  group: "block",
  content: "(paragraph|bulletList|orderedList)+",
  defining: true,
  addAttributes() {
    return {
      tone: {
        default: "note",
        parseHTML: (element) =>
          normalizeArticleCalloutTone(element.getAttribute("data-tone")),
      },
      icon: {
        default: null,
        parseHTML: (element) =>
          normalizeArticleCalloutIcon(element.getAttribute("data-icon")),
      },
    }
  },
  parseHTML: () => [{ tag: "aside[data-article-node='callout']" }],
  renderHTML: ({ node }) => [
    "aside",
    {
      "data-article-node": "callout",
      "data-node-id": node.attrs.node_id,
      "data-tone": normalizeArticleCalloutTone(node.attrs.tone),
      "data-icon": normalizeArticleCalloutIcon(node.attrs.icon),
    },
    0,
  ],
  addNodeView() {
    return ReactNodeViewRenderer(ArticleCalloutNodeView)
  },
})

const ArticleDetails = Node.create({
  name: "details",
  group: "block",
  content: "detailsContent+",
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      summary: {
        default: "问题",
        parseHTML: (element) =>
          normalizeArticleDetailsSummary(
            element.querySelector(":scope > summary")?.textContent
          ),
      },
      open_by_default: {
        default: false,
        parseHTML: (element) => element.hasAttribute("open"),
      },
    }
  },
  parseHTML: () => [{ tag: "details[data-article-node='details']" }],
  renderHTML: ({ node }) => [
    "details",
    {
      "data-article-node": "details",
      "data-node-id": node.attrs.node_id,
      open: node.attrs.open_by_default ? "open" : null,
    },
    ["summary", node.attrs.summary],
    ["div", { "data-article-details-body": "" }, 0],
  ],
  addNodeView() {
    return ReactNodeViewRenderer(ArticleDetailsNodeView)
  },
})

const ArticleDetailsContent = Node.create({
  name: "detailsContent",
  content: "(paragraph|bulletList|orderedList)+",
  defining: true,
  selectable: false,
  parseHTML: () => [{ tag: "div[data-article-details-content]" }],
  renderHTML: () => ["div", { "data-article-details-content": "" }, 0],
})

export type ArticleEditorExtensionOptions = {
  mediaRuntime?: ArticleMediaRuntimeStorage
  enhancedRuntime?: ArticleEnhancedCardRuntimeStorage
  uploadPlaceholders?: ArticleUploadPlaceholderHandlers
  onPasteFiles?: (files: File[]) => void
  onDropFiles?: (files: File[], position: number) => void
  onPasteReview?: (request: ArticlePasteReviewRequest) => void
  onOpenLink?: () => void
}

const defaultMediaRuntime: ArticleMediaRuntimeStorage = {
  projectId: "",
  readOnly: true,
  assetAccess: new ArticleAssetAccessStore(""),
  replace: () => undefined,
  addGalleryItems: () => undefined,
  replacePoster: () => undefined,
}

const defaultEnhancedRuntime: ArticleEnhancedCardRuntimeStorage = {
  readOnly: true,
  open: () => undefined,
  refreshBookmark: async (url) => ({
    kind: "link",
    source_url: url,
    final_url: url,
    title: null,
    description: null,
    publisher: null,
    icon_url: null,
    image_url: null,
    fetched_at: null,
    error_code: "bookmark_runtime_unavailable",
    retryable: false,
  }),
  fallback: () => false,
}

export function createArticleEditorExtensions(
  options: ArticleEditorExtensionOptions = {}
) {
  const mediaRuntime = options.mediaRuntime ?? defaultMediaRuntime
  const enhancedRuntime = options.enhancedRuntime ?? defaultEnhancedRuntime
  return [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [2, 3, 4, 5, 6] },
      link: false,
      underline: false,
      trailingNode: false,
    }),
    ArticleDocumentAttributes,
    ArticleNodeId,
    ArticleAIEditExtension,
    ArticleImage,
    ArticleGallery,
    ArticleCodeBlock.configure({
      lowlight: articleCodeLowlight,
      defaultLanguage: null,
      enableTabIndentation: true,
      tabSize: 2,
    }),
    TableKit.configure({
      table: {
        HTMLAttributes: { "data-article-node": "table" },
        allowTableNodeSelection: true,
        resizable: true,
        renderWrapper: true,
      },
      tableCell: false,
      tableHeader: false,
    }),
    ArticleTableCell,
    ArticleTableHeader,
    ArticleFile,
    ArticleAudio,
    ArticleVideo,
    ArticleBookmark,
    ArticleCallout,
    ArticleDetails,
    ArticleDetailsContent,
    ArticleButton,
    ArticleEmbed,
    Extension.create({
      name: "articleMediaRuntime",
      addStorage: () => mediaRuntime,
    }),
    Extension.create({
      name: "articleEnhancedCardRuntime",
      addStorage: () => enhancedRuntime,
    }),
    Extension.create({
      name: "articleUploadPlaceholder",
      addProseMirrorPlugins: () => [
        articleUploadPlaceholderPlugin(options.uploadPlaceholders),
      ],
    }),
    FileHandler.configure({
      allowedMimeTypes: [
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "audio/mpeg",
        "audio/mp4",
        "audio/ogg",
        "audio/wav",
        "video/mp4",
        "video/webm",
        "application/pdf",
      ],
      consumePasteEvent: true,
      onPaste: (_editor, files) => options.onPasteFiles?.(files),
      onDrop: (_editor, files, position) =>
        options.onDropFiles?.(files, position),
    }),
    Underline,
    TextAlign.configure({
      types: ["paragraph", "heading"],
      alignments: ["left", "center", "right"],
    }),
    Highlight.configure({ multicolor: true }),
    Link.configure({
      autolink: false,
      linkOnPaste: false,
      openOnClick: false,
      protocols: ["http", "https"],
      HTMLAttributes: {
        target: null,
        rel: null,
      },
    }),
    Extension.create({
      name: "articleLinkShortcut",
      addKeyboardShortcuts() {
        return {
          "Mod-k": () => {
            options.onOpenLink?.()
            return Boolean(options.onOpenLink)
          },
        }
      },
    }),
    Placeholder.configure({ placeholder: "开始撰写正文..." }),
    CharacterCount.configure({ limit: 200_000 }),
    Extension.create({
      name: "articlePasteSanitizer",
      priority: 90,
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: new PluginKey("articlePasteSanitizer"),
            props: {
              transformPastedHTML: sanitizeArticlePasteHtml,
              handlePaste: (view, event) => {
                const html = event.clipboardData?.getData("text/html")
                if (!html || !options.onPasteReview) return false
                const review = reviewArticlePasteHtml(html)
                if (!review.requiresConfirmation) return false
                options.onPasteReview({
                  ...review,
                  from: view.state.selection.from,
                  to: view.state.selection.to,
                })
                return true
              },
            },
          }),
        ]
      },
    }),
  ]
}

export const articleEditorExtensions = createArticleEditorExtensions()

export const articleCommandRegistry = [
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "blockquote",
  "bulletList",
  "orderedList",
  "codeBlock",
  "horizontalRule",
  "link",
] as const
