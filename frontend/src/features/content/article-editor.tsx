import { getMarkRange, type Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import * as React from "react"
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Check,
  ChevronDown,
  Code,
  CreditCard,
  Eraser,
  FileCode2,
  Highlighter,
  Italic,
  Link2,
  List,
  ListOrdered,
  Library,
  Minus,
  MoreHorizontal,
  Paperclip,
  PanelTop,
  Plus,
  Pilcrow,
  Quote,
  Redo2,
  Sparkles,
  Strikethrough,
  Underline,
  Undo2,
  Unlink,
  Upload,
  Video,
} from "lucide-react"

import type { AssetType, ContentAsset } from "@/api/assets"
import type {
  ArticleDocument,
  ArticleDocumentCapabilities,
  ArticleMetadataSnapshot,
  ArticleRequestOptions,
  ArticleSeoFieldKey,
} from "@/api/articles"
import { refreshArticleBookmark } from "@/api/articles"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  articleDocumentToEditorJson,
  canonicalArticleDocumentSnapshot,
  editorJsonToArticleDocument,
} from "@/features/content/article-document"
import { ArticleAssetAccessStore } from "@/features/content/article-asset-access"
import { useArticleAIEditController } from "@/features/content/article-ai-edit"
import { createArticleEditorExtensions } from "@/features/content/article-editor-extensions"
import { ArticleEditorOperationLayer } from "@/features/content/article-editor-operation-layer"
import { ArticleEnhancedCardDialog } from "@/features/content/article-enhanced-card-dialog"
import type { ArticleEnhancedCardRuntimeStorage } from "@/features/content/article-enhanced-card-nodeviews"
import {
  articleEnhancedFallbackContent,
  replaceEnhancedCardWithLink,
  type ArticleEnhancedCardSubmission,
  type ArticleEnhancedCardType,
} from "@/features/content/article-enhanced-cards"
import {
  ARTICLE_HIGHLIGHT_COLORS,
  buildArticlePasteInsertion,
  type ArticlePasteReviewRequest,
} from "@/features/content/article-editor-paste"
import { ArticleLinkDialog } from "@/features/content/article-link-dialog"
import {
  normalizeArticleLinkValue,
  type ArticleLinkValue,
} from "@/features/content/article-link"
import { articleMediaNodeId } from "@/features/content/article-media-document"
import {
  applyReadyAssetToArticleEditor,
  articleMediaInsertionPosition,
  findArticleNodeById,
  removeArticleUploadAnchor,
  type ReadyGalleryUploadGroups,
} from "@/features/content/article-media-editor"
import {
  ArticleImagePropertiesDialog,
  ArticleMediaDialog,
  type ArticleMediaDialogMode,
} from "@/features/content/article-media-dialog"
import type {
  ArticleMediaReplaceTarget,
  ArticleMediaRuntimeStorage,
} from "@/features/content/article-media-nodeviews"
import type {
  ArticleImageProperties,
  ArticleUploadIntent,
  ArticleUploadSource,
  ArticleUploadTask,
} from "@/features/content/article-upload-queue"
import {
  articleGalleryUploadGroupKey,
  createArticleLibraryTask,
} from "@/features/content/article-upload-queue"
import {
  addArticleUploadPlaceholder,
  findArticleUploadPlaceholder,
  removeArticleUploadPlaceholder,
  updateArticleUploadPlaceholder,
} from "@/features/content/article-upload-placeholder"
import { useArticleUploadQueue } from "@/features/content/use-article-upload-queue"
import { cn } from "@/lib/utils"

function clampPosition(editor: Editor, position: number) {
  return Math.max(0, Math.min(position, editor.state.doc.content.size))
}

type PendingPicker = {
  assetType: AssetType
  multiple: boolean
  intent: (index: number, total: number) => ArticleUploadIntent
  attachUploadId?: string
  replaceUploadId?: string
}

type PendingMediaDialog = {
  mode: ArticleMediaDialogMode
  assetType: AssetType
  multiple: boolean
  minimumSelection: number
  maximumSelection: number
  intent: (index: number, total: number) => ArticleUploadIntent
}

type PendingImageProperties = {
  task: ArticleUploadTask
  asset: ContentAsset
}

type PendingTextLink = {
  from: number
  to: number
  anchorText: string
  value: ArticleLinkValue
}

type PendingPasteReview = ArticlePasteReviewRequest & {
  selectedImageIndexes: Set<number>
}

type PendingEnhancedDialog = {
  type: ArticleEnhancedCardType
  nodeId?: string
}

type ArticleUploadQueueController = ReturnType<typeof useArticleUploadQueue>

class ArticleEditorRuntimeBridge implements ArticleMediaRuntimeStorage {
  public projectId: string
  public readOnly: boolean
  public assetAccess: ArticleAssetAccessStore
  private editor: Editor | null = null
  private uploadQueue: ArticleUploadQueueController | null = null
  private listeners = new Set<() => void>()
  private enqueueFilesHandler: (
    files: File[],
    source: Exclude<ArticleUploadSource, "url" | "library">,
    position: number
  ) => void = () => undefined
  private openFilePickerHandler: (picker: PendingPicker) => void = () =>
    undefined
  private replaceHandler: (target: ArticleMediaReplaceTarget) => void = () =>
    undefined
  private addGalleryItemsHandler: (nodeId: string) => void = () => undefined
  private replacePosterHandler: (nodeId: string) => void = () => undefined

  constructor(
    projectId: string,
    readOnly: boolean,
    assetAccess: ArticleAssetAccessStore
  ) {
    this.projectId = projectId
    this.readOnly = readOnly
    this.assetAccess = assetAccess
  }

  setEditor(editor: Editor | null) {
    this.editor = editor
  }

  getEditor() {
    return this.editor
  }

  getUploadTasks() {
    return this.uploadQueue?.tasks ?? []
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getReadOnly = () => this.readOnly

  setUploadQueue(uploadQueue: ArticleUploadQueueController) {
    this.uploadQueue = uploadQueue
  }

  configure(input: {
    projectId: string
    readOnly: boolean
    enqueueFiles: ArticleEditorRuntimeBridge["enqueueFilesHandler"]
    openFilePicker: ArticleEditorRuntimeBridge["openFilePickerHandler"]
    replace: ArticleEditorRuntimeBridge["replaceHandler"]
    addGalleryItems: ArticleEditorRuntimeBridge["addGalleryItemsHandler"]
    replacePoster: ArticleEditorRuntimeBridge["replacePosterHandler"]
  }) {
    const readOnlyChanged = this.readOnly !== input.readOnly
    this.projectId = input.projectId
    this.readOnly = input.readOnly
    this.enqueueFilesHandler = input.enqueueFiles
    this.openFilePickerHandler = input.openFilePicker
    this.replaceHandler = input.replace
    this.addGalleryItemsHandler = input.addGalleryItems
    this.replacePosterHandler = input.replacePoster
    if (readOnlyChanged) {
      for (const listener of this.listeners) listener()
    }
  }

  readonly replace = (target: ArticleMediaReplaceTarget) => {
    this.replaceHandler(target)
  }

  readonly addGalleryItems = (nodeId: string) => {
    this.addGalleryItemsHandler(nodeId)
  }

  readonly replacePoster = (nodeId: string) => {
    this.replacePosterHandler(nodeId)
  }

  readonly cancelUpload = (uploadId: string) => {
    const task = this.uploadQueue?.tasks.find(
      (item) => item.uploadId === uploadId
    )
    if (this.editor && task) removeArticleUploadAnchor(this.editor, task)
    void this.uploadQueue?.cancel(uploadId)
  }

  readonly retryUpload = (uploadId: string) => {
    this.uploadQueue?.retry(uploadId)
  }

  readonly reselectUpload = (uploadId: string) => {
    const task = this.uploadQueue?.tasks.find(
      (item) => item.uploadId === uploadId
    )
    if (!task) return
    this.openFilePickerHandler({
      assetType: task.assetType,
      multiple: false,
      intent: () => task.intent,
      attachUploadId: uploadId,
    })
  }

  readonly replaceUploadFile = (uploadId: string) => {
    const task = this.uploadQueue?.tasks.find(
      (item) => item.uploadId === uploadId
    )
    if (!task) return
    this.openFilePickerHandler({
      assetType: task.assetType,
      multiple: false,
      intent: () => task.intent,
      replaceUploadId: uploadId,
    })
  }

  readonly pasteFiles = (files: File[]) => {
    const position = this.editor?.state.selection.from ?? 0
    this.enqueueFilesHandler(files, "paste", position)
  }

  readonly dropFiles = (files: File[], position: number) => {
    this.enqueueFilesHandler(files, "drop", position)
  }
}

class ArticleEnhancedRuntimeBridge implements ArticleEnhancedCardRuntimeStorage {
  public readOnly: boolean
  private openHandler: (
    type: ArticleEnhancedCardType,
    nodeId?: string
  ) => void = () => undefined
  private refreshBookmarkHandler: ArticleEnhancedCardRuntimeStorage["refreshBookmark"] =
    async (url) => ({
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
    })
  private fallbackHandler: ArticleEnhancedCardRuntimeStorage["fallback"] = () =>
    false

  constructor(readOnly: boolean) {
    this.readOnly = readOnly
  }

  configure(input: {
    readOnly: boolean
    open: ArticleEnhancedRuntimeBridge["openHandler"]
    refreshBookmark: ArticleEnhancedCardRuntimeStorage["refreshBookmark"]
    fallback: ArticleEnhancedCardRuntimeStorage["fallback"]
  }) {
    this.readOnly = input.readOnly
    this.openHandler = input.open
    this.refreshBookmarkHandler = input.refreshBookmark
    this.fallbackHandler = input.fallback
  }

  readonly open = (type: ArticleEnhancedCardType, nodeId?: string) => {
    this.openHandler(type, nodeId)
  }

  readonly refreshBookmark = (url: string) => this.refreshBookmarkHandler(url)

  readonly fallback = (nodeId: string, href: string, label: string) =>
    this.fallbackHandler(nodeId, href, label)
}

export type ArticleEditorHandle = {
  focusEvidence(input: {
    nodeId: string
    start: number
    end: number
    expectedText?: string | null
  }): boolean
  focusLink(input: {
    nodeId: string
    start: number
    end: number
    expectedText?: string | null
    href?: string | null
  }): boolean
  captureLinkCandidateSelection(): boolean
  insertLinkCandidate(input: { href: string; suggestedAnchor: string }): boolean
}

type ArticleEditorProps = {
  projectId: string
  articleId: string
  document: ArticleDocument
  metadata?: ArticleMetadataSnapshot
  reviewVersion?: number
  capabilities: ArticleDocumentCapabilities
  readOnly: boolean
  onChange: (
    document: ArticleDocument,
    context: { source: "initialization" | "editor" }
  ) => void
  requestOptions?: Omit<ArticleRequestOptions, "signal">
  onMetadataChange?: (field: ArticleSeoFieldKey, value: string) => void
  className?: string
}

export const ArticleEditor = React.forwardRef<
  ArticleEditorHandle,
  ArticleEditorProps
>(function ArticleEditor(
  {
    projectId,
    articleId,
    document,
    metadata,
    reviewVersion,
    capabilities,
    readOnly,
    onChange,
    requestOptions,
    onMetadataChange,
    className,
  }: ArticleEditorProps,
  ref
) {
  const acceptsUserChanges = React.useRef(false)
  const linkCandidateSelection = React.useRef<{
    from: number
    to: number
    document: Editor["state"]["doc"]
  } | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const pendingPicker = React.useRef<PendingPicker | null>(null)
  const readyGalleryUploads = React.useRef<ReadyGalleryUploadGroups>(new Map())
  const [mediaDialog, setMediaDialog] =
    React.useState<PendingMediaDialog | null>(null)
  const [pendingImageProperties, setPendingImageProperties] = React.useState<
    PendingImageProperties[]
  >([])
  const [textLink, setTextLink] = React.useState<PendingTextLink | null>(null)
  const [pasteReview, setPasteReview] =
    React.useState<PendingPasteReview | null>(null)
  const [enhancedDialog, setEnhancedDialog] =
    React.useState<PendingEnhancedDialog | null>(null)
  const [mediaNotice, setMediaNotice] = React.useState("")
  const mediaEnabled = !readOnly && capabilities.media_upload_enabled
  const aiEnabled = Boolean(
    !readOnly && metadata && reviewVersion && onMetadataChange
  )
  const enhancedNodes = new Set(capabilities.nodes)
  const enhancedEnabled =
    !readOnly &&
    ["bookmark", "button", "embed"].some((node) => enhancedNodes.has(node))
  const [assetAccess] = React.useState(
    () => new ArticleAssetAccessStore(projectId, requestOptions)
  )
  const [runtimeBridge] = React.useState(
    () => new ArticleEditorRuntimeBridge(projectId, !mediaEnabled, assetAccess)
  )
  const [enhancedRuntime] = React.useState(
    () => new ArticleEnhancedRuntimeBridge(readOnly)
  )
  const accessToken = requestOptions?.accessToken
  const requestId = requestOptions?.requestId

  const onAssetReady = React.useCallback(
    (task: ArticleUploadTask, asset: ContentAsset) => {
      const editor = runtimeBridge.getEditor()
      if (!editor || editor.isDestroyed) return
      const intent = task.intent
      const imageIntent =
        intent.kind === "insert" ||
        intent.kind === "gallery" ||
        intent.kind === "gallery_add"
      const needsImageProperties =
        ((intent.kind === "insert" && intent.nodeType === "image") ||
          intent.kind === "gallery" ||
          intent.kind === "gallery_add") &&
        ((task.source === "library" && !intent.imagePropertiesConfirmed) ||
          (imageIntent && intent.decorative !== true && !intent.alt?.trim()))
      if (needsImageProperties) {
        setPendingImageProperties((current) =>
          current.some((item) => item.task.uploadId === task.uploadId)
            ? current
            : [...current, { task, asset }]
        )
        return
      }
      acceptsUserChanges.current = true
      const existing = runtimeBridge.getUploadTasks()
      return applyReadyAssetToArticleEditor({
        editor,
        task,
        asset,
        readyGroups: readyGalleryUploads.current,
        allTasks: existing.some((item) => item.uploadId === task.uploadId)
          ? existing
          : [...existing, task],
      })
    },
    [runtimeBridge]
  )

  const uploadQueue = useArticleUploadQueue({
    projectId,
    articleId,
    onReady: onAssetReady,
    requestOptions,
  })

  const openFilePicker = React.useCallback((picker: PendingPicker) => {
    pendingPicker.current = picker
    const input = fileInputRef.current
    if (!input) return
    input.accept =
      picker.assetType === "image"
        ? "image/jpeg,image/png,image/gif,image/webp"
        : picker.assetType === "audio"
          ? "audio/mpeg,audio/mp4,audio/ogg,audio/wav"
          : picker.assetType === "video"
            ? "video/mp4,video/webm"
            : "application/pdf"
    input.multiple = picker.multiple
    input.click()
  }, [])

  const enqueueFiles = React.useCallback(
    (
      files: File[],
      source: Exclude<ArticleUploadSource, "url" | "library">,
      position: number,
      explicit?: PendingPicker
    ) => {
      const editor = runtimeBridge.getEditor()
      if (!editor || !mediaEnabled || files.length === 0) return
      const insertionPosition = articleMediaInsertionPosition(editor, position)
      const picker =
        explicit ??
        ({
          assetType: files[0].type.startsWith("image/")
            ? "image"
            : files[0].type.startsWith("audio/")
              ? "audio"
              : files[0].type.startsWith("video/")
                ? "video"
                : "file",
          multiple: files.length > 1,
          intent: (index: number) => ({
            kind: "insert",
            nodeType: files[index].type.startsWith("image/")
              ? "image"
              : files[index].type.startsWith("audio/")
                ? "audio"
                : files[index].type.startsWith("video/")
                  ? "video"
                  : "file",
            position: insertionPosition,
          }),
        } satisfies PendingPicker)
      const tasks = uploadQueue.enqueueFiles(
        files.map((file, index) => ({
          file,
          source,
          assetType: picker.assetType,
          intent: picker.intent(index, files.length),
        }))
      )
      tasks.forEach((task, index) => {
        addArticleUploadPlaceholder(editor, {
          uploadId: task.uploadId,
          pos: clampPosition(editor, insertionPosition),
          filename: task.filename,
          previewUrl: task.previewUrl,
          assetType: task.assetType,
          side: index,
        })
      })
    },
    [mediaEnabled, runtimeBridge, uploadQueue]
  )

  const replaceMedia = React.useCallback(
    (target: ArticleMediaReplaceTarget) => {
      if (!mediaEnabled) return
      setMediaDialog({
        mode: "library",
        assetType: target.assetType,
        multiple: false,
        minimumSelection: 1,
        maximumSelection: 1,
        intent: () => ({
          kind: "replace",
          nodeId: target.nodeId,
          nodeType: target.nodeType,
          ...(target.itemId ? { itemId: target.itemId } : {}),
        }),
      })
    },
    [mediaEnabled]
  )

  const addGalleryItems = React.useCallback(
    (nodeId: string) => {
      if (!mediaEnabled) return
      const galleryNodeId = nodeId
      const batchId = articleMediaNodeId("batch")
      setMediaDialog({
        mode: "library",
        assetType: "image",
        multiple: true,
        minimumSelection: 1,
        maximumSelection: 20,
        intent: (order, totalItems) => ({
          kind: "gallery_add",
          galleryNodeId,
          batchId,
          itemId: articleMediaNodeId("item"),
          order,
          totalItems,
        }),
      })
    },
    [mediaEnabled]
  )

  const replacePoster = React.useCallback(
    (nodeId: string) => {
      if (!mediaEnabled) return
      setMediaDialog({
        mode: "library",
        assetType: "image",
        multiple: false,
        minimumSelection: 1,
        maximumSelection: 1,
        intent: () => ({ kind: "poster", nodeId }),
      })
    },
    [mediaEnabled]
  )

  const openInsertMedia = React.useCallback(
    (
      assetType: AssetType,
      gallery = false,
      mode: ArticleMediaDialogMode = "upload"
    ) => {
      const editor = runtimeBridge.getEditor()
      if (!editor || !mediaEnabled) return
      const position = articleMediaInsertionPosition(
        editor,
        editor.state.selection.from
      )
      if (gallery) {
        const galleryNodeId = articleMediaNodeId("gallery")
        const batchId = articleMediaNodeId("batch")
        setMediaDialog({
          mode,
          assetType: "image",
          multiple: true,
          minimumSelection: 2,
          maximumSelection: 20,
          intent: (order, totalItems) => ({
            kind: "gallery",
            galleryNodeId,
            batchId,
            itemId: articleMediaNodeId("item"),
            position,
            order,
            totalItems,
          }),
        })
        return
      }
      setMediaDialog({
        mode,
        assetType,
        multiple: false,
        minimumSelection: 1,
        maximumSelection: 1,
        intent: () => ({
          kind: "insert",
          nodeType: assetType === "image" ? "image" : assetType,
          position,
        }),
      })
    },
    [mediaEnabled, runtimeBridge]
  )

  const openMediaDialog = React.useCallback(
    (mode: ArticleMediaDialogMode, assetType: AssetType) => {
      openInsertMedia(assetType, false, mode)
    },
    [openInsertMedia]
  )

  const openTextLink = React.useCallback(() => {
    const editor = runtimeBridge.getEditor()
    if (!editor) return
    const { from, to, empty } = editor.state.selection
    if (empty && !editor.isActive("link")) return
    const existingRange = empty
      ? getMarkRange(editor.state.doc.resolve(from), editor.schema.marks.link)
      : null
    const range = existingRange ?? { from, to }
    const attributes = editor.getAttributes("link")
    setTextLink({
      from: range.from,
      to: range.to,
      anchorText: editor.state.doc.textBetween(range.from, range.to, " "),
      value: {
        href: typeof attributes.href === "string" ? attributes.href : "",
        target: attributes.target === "_blank" ? "_blank" : null,
        rel: typeof attributes.rel === "string" ? attributes.rel : null,
        title: typeof attributes.title === "string" ? attributes.title : null,
        link_kind:
          attributes.link_kind === "internal" ||
          attributes.link_kind === "external"
            ? attributes.link_kind
            : null,
      },
    })
  }, [runtimeBridge])

  const openPasteReview = React.useCallback(
    (request: ArticlePasteReviewRequest) => {
      setPasteReview({
        ...request,
        selectedImageIndexes: new Set(
          mediaEnabled ? request.remoteImages.map((_, index) => index) : []
        ),
      })
    },
    [mediaEnabled]
  )

  const [extensions] = React.useState(() =>
    createArticleEditorExtensions({
      mediaRuntime: runtimeBridge,
      enhancedRuntime,
      uploadPlaceholders: {
        onCancel: runtimeBridge.cancelUpload,
        onRemove: runtimeBridge.cancelUpload,
        onRetry: runtimeBridge.retryUpload,
        onReselect: runtimeBridge.reselectUpload,
        onReplaceFile: runtimeBridge.replaceUploadFile,
      },
      onPasteFiles: runtimeBridge.pasteFiles,
      onDropFiles: runtimeBridge.dropFiles,
      onPasteReview: openPasteReview,
      onOpenLink: openTextLink,
    })
  )

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: articleDocumentToEditorJson(document),
    editable: !readOnly,
    onTransaction: ({ transaction }) => {
      if (!transaction.docChanged) return
      setTextLink((current) =>
        current
          ? {
              ...current,
              from: transaction.mapping.map(current.from, -1),
              to: transaction.mapping.map(current.to, 1),
            }
          : null
      )
      setPasteReview((current) =>
        current
          ? {
              ...current,
              from: transaction.mapping.map(current.from, -1),
              to: transaction.mapping.map(current.to, 1),
            }
          : null
      )
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (readOnly) return
      onChange(editorJsonToArticleDocument(currentEditor.getJSON()), {
        source: acceptsUserChanges.current ? "editor" : "initialization",
      })
    },
  })

  const aiEdit = useArticleAIEditController({
    editor,
    projectId,
    articleId,
    reviewVersion: reviewVersion ?? 0,
    metadata: metadata ?? {
      title: null,
      slug: null,
      meta_title: null,
      meta_description: null,
      focus_keyword: null,
      secondary_keywords: [],
      canonical_url: null,
      indexing: "index/follow",
      field_states: {},
      publication_status: "complete_draft",
    },
    requestOptions,
    onBeforeDocumentAccept: () => {
      acceptsUserChanges.current = true
    },
    onMetadataAccept: onMetadataChange ?? (() => undefined),
  })

  React.useEffect(() => {
    assetAccess.configure(projectId, { accessToken, requestId })
    return () => assetAccess.dispose()
  }, [accessToken, assetAccess, projectId, requestId])

  React.useEffect(() => {
    runtimeBridge.setEditor(editor)
    return () => runtimeBridge.setEditor(null)
  }, [editor, runtimeBridge])

  React.useEffect(() => {
    runtimeBridge.setUploadQueue(uploadQueue)
  }, [runtimeBridge, uploadQueue])

  React.useEffect(() => {
    runtimeBridge.configure({
      projectId,
      readOnly: !mediaEnabled,
      enqueueFiles,
      openFilePicker,
      replace: replaceMedia,
      addGalleryItems,
      replacePoster,
    })
  }, [
    addGalleryItems,
    enqueueFiles,
    mediaEnabled,
    openFilePicker,
    projectId,
    replaceMedia,
    replacePoster,
    runtimeBridge,
  ])

  React.useEffect(() => {
    enhancedRuntime.configure({
      readOnly,
      open: (type, nodeId) => setEnhancedDialog({ type, nodeId }),
      refreshBookmark: (url) =>
        refreshArticleBookmark(projectId, articleId, url, requestOptions),
      fallback: (nodeId, href, label) => {
        const current = runtimeBridge.getEditor()
        return current
          ? replaceEnhancedCardWithLink(current, nodeId, href, label)
          : false
      },
    })
  }, [
    articleId,
    enhancedRuntime,
    projectId,
    readOnly,
    requestOptions,
    runtimeBridge,
  ])

  React.useEffect(() => {
    editor?.setEditable(!readOnly)
  }, [editor, readOnly])

  React.useEffect(() => {
    if (!editor) return
    for (const task of uploadQueue.tasks) {
      const position = findArticleUploadPlaceholder(editor, task.uploadId)
      if (task.status === "cancelled") {
        removeArticleUploadAnchor(editor, task)
        if (position !== undefined) {
          removeArticleUploadPlaceholder(editor, task.uploadId)
        }
        continue
      }
      if (position === undefined && task.status !== "ready") {
        const anchorPosition =
          task.intent.kind === "insert" && task.intent.anchorNodeId
            ? findArticleNodeById(editor, task.intent.anchorNodeId)?.position
            : undefined
        const intentPosition =
          anchorPosition ??
          (task.intent.kind === "insert" || task.intent.kind === "gallery"
            ? task.intent.position
            : editor.state.selection.from)
        addArticleUploadPlaceholder(editor, {
          uploadId: task.uploadId,
          pos: clampPosition(editor, intentPosition),
          filename: task.filename,
          previewUrl: task.previewUrl,
          assetType: task.assetType,
        })
      }
      const groupKey = articleGalleryUploadGroupKey(task.intent)
      const groupTasks = groupKey
        ? uploadQueue.tasks.filter(
            (candidate) =>
              articleGalleryUploadGroupKey(candidate.intent) === groupKey
          )
        : []
      updateArticleUploadPlaceholder(
        editor,
        task,
        groupKey
          ? {
              completed: groupTasks.filter(
                (candidate) => candidate.status === "ready"
              ).length,
              total: groupTasks.length,
            }
          : undefined
      )
    }
  }, [editor, uploadQueue.tasks])

  React.useEffect(() => {
    if (!editor) return
    const next = articleDocumentToEditorJson(document)
    const currentDocument = editorJsonToArticleDocument(editor.getJSON())
    if (
      canonicalArticleDocumentSnapshot(currentDocument) ===
      canonicalArticleDocumentSnapshot(document)
    ) {
      return
    }
    editor.commands.setContent(next, { emitUpdate: false })
  }, [document, editor])

  React.useImperativeHandle(
    ref,
    () => ({
      focusEvidence(input) {
        const current = runtimeBridge.getEditor()
        if (!current || current.isDestroyed) return false
        const located = findArticleNodeById(current, input.nodeId)
        if (!located || !located.node.isTextblock) return false
        const start = Math.max(0, input.start)
        const end = Math.max(start, input.end)
        const text = located.node.textContent
        if (end > text.length) return false
        if (
          input.expectedText != null &&
          text.slice(start, end) !== input.expectedText
        ) {
          return false
        }
        current
          .chain()
          .focus()
          .setTextSelection({
            from: located.position + 1 + start,
            to: located.position + 1 + end,
          })
          .scrollIntoView()
          .run()
        return true
      },
      focusLink(input) {
        const current = runtimeBridge.getEditor()
        if (!current || current.isDestroyed) return false
        const located = findArticleNodeById(current, input.nodeId)
        if (!located) return false
        if (located.node.isAtom) {
          const href = String(
            located.node.attrs.href ?? located.node.attrs.url ?? ""
          )
          if (input.href && href !== input.href) return false
          current.chain().focus().setNodeSelection(located.position).run()
          return true
        }
        if (!located.node.isTextblock) return false
        const start = Math.max(0, input.start)
        const end = Math.max(start, input.end)
        const text = located.node.textContent
        if (end > text.length) return false
        if (
          input.expectedText != null &&
          text.slice(start, end) !== input.expectedText
        ) {
          return false
        }
        if (input.href) {
          let matchesHref = false
          located.node.nodesBetween(start, end, (node) => {
            if (!node.isText) return
            matchesHref ||= node.marks.some(
              (mark) =>
                mark.type === current.schema.marks.link &&
                mark.attrs.href === input.href
            )
          })
          if (!matchesHref) return false
        }
        current
          .chain()
          .focus()
          .setTextSelection({
            from: located.position + 1 + start,
            to: located.position + 1 + end,
          })
          .scrollIntoView()
          .run()
        return true
      },
      captureLinkCandidateSelection() {
        const current = runtimeBridge.getEditor()
        if (!current || current.isDestroyed || readOnly) {
          linkCandidateSelection.current = null
          return false
        }
        const { from, to, empty, $from } = current.state.selection
        if (empty || !$from.parent.inlineContent) {
          linkCandidateSelection.current = null
          return false
        }
        linkCandidateSelection.current = {
          from,
          to,
          document: current.state.doc,
        }
        return true
      },
      insertLinkCandidate(input) {
        const current = runtimeBridge.getEditor()
        if (!current || current.isDestroyed || readOnly) return false
        const currentSelection = current.state.selection
        const captured = linkCandidateSelection.current
        linkCandidateSelection.current = null
        const selection =
          !currentSelection.empty && currentSelection.$from.parent.inlineContent
            ? { from: currentSelection.from, to: currentSelection.to }
            : captured && captured.document.eq(current.state.doc)
              ? { from: captured.from, to: captured.to }
              : null
        if (!selection) {
          return false
        }
        const normalized = normalizeArticleLinkValue({ href: input.href })
        const anchor = input.suggestedAnchor.trim()
        if (!normalized || !anchor) return false
        acceptsUserChanges.current = true
        return current
          .chain()
          .focus()
          .insertContentAt(selection, {
            type: "text",
            text: anchor,
            marks: [{ type: "link", attrs: normalized }],
          })
          .run()
      },
    }),
    [readOnly, runtimeBridge]
  )

  if (!editor) {
    return (
      <div className="min-h-96 bg-muted/30" aria-label="文章编辑器加载中" />
    )
  }

  const tool = (
    label: string,
    active: boolean,
    action: () => void,
    icon: React.ReactNode,
    disabled = false,
    pressed: boolean | "mixed" = active
  ) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={action}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )

  const addTaskPlaceholder = (task: ArticleUploadTask) => {
    const intent = task.intent
    const anchorPosition =
      intent.kind === "insert" && intent.anchorNodeId
        ? findArticleNodeById(editor, intent.anchorNodeId)?.position
        : undefined
    const position =
      anchorPosition ??
      (intent.kind === "insert" || intent.kind === "gallery"
        ? intent.position
        : editor.state.selection.from)
    addArticleUploadPlaceholder(editor, {
      uploadId: task.uploadId,
      pos: clampPosition(editor, position),
      filename: task.filename,
      previewUrl: task.previewUrl,
      assetType: task.assetType,
    })
  }

  return (
    <div
      className={cn(
        "overflow-hidden border-y bg-background sm:border-x",
        className
      )}
      onBeforeInputCapture={() => {
        acceptsUserChanges.current = true
      }}
      onCompositionStartCapture={() => {
        acceptsUserChanges.current = true
      }}
      onKeyDownCapture={() => {
        acceptsUserChanges.current = true
      }}
      onPasteCapture={() => {
        acceptsUserChanges.current = true
      }}
      onDropCapture={() => {
        acceptsUserChanges.current = true
      }}
      onPointerDownCapture={() => {
        acceptsUserChanges.current = true
      }}
    >
      {!readOnly && (
        <div className="sticky top-0 z-20 overflow-x-auto border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/90">
          <div className="flex min-h-11 min-w-max items-center gap-1 px-2 py-1.5">
            {tool(
              "撤销",
              false,
              () => editor.chain().focus().undo().run(),
              <Undo2 />,
              !editor.can().chain().focus().undo().run()
            )}
            {tool(
              "重做",
              false,
              () => editor.chain().focus().redo().run(),
              <Redo2 />,
              !editor.can().chain().focus().redo().run()
            )}
            <Separator orientation="vertical" className="mx-1 h-6" />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="段落与标题"
                    title="段落与标题"
                  />
                }
              >
                {editor.isActive("heading") ? (
                  <span>
                    H{editor.getAttributes("heading").level as number}
                  </span>
                ) : (
                  <Pilcrow />
                )}
                <ChevronDown />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="rounded-md" align="start">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>段落与标题</DropdownMenuLabel>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={
                      !editor.can().chain().focus().setParagraph().run()
                    }
                    onClick={() => editor.chain().focus().setParagraph().run()}
                  >
                    <Pilcrow /> 正文
                    {editor.isActive("paragraph") && (
                      <Check className="ml-auto" />
                    )}
                  </DropdownMenuItem>
                  {([2, 3, 4, 5, 6] as const).map((level) => (
                    <DropdownMenuItem
                      key={level}
                      className="rounded-sm"
                      disabled={
                        !editor
                          .can()
                          .chain()
                          .focus()
                          .toggleHeading({ level })
                          .run()
                      }
                      onClick={() =>
                        editor.chain().focus().toggleHeading({ level }).run()
                      }
                    >
                      H{level} {level} 级标题
                      {editor.isActive("heading", { level }) && (
                        <Check className="ml-auto" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Separator orientation="vertical" className="mx-1 h-6" />
            {tool(
              "粗体",
              editor.isActive("bold"),
              () => editor.chain().focus().toggleBold().run(),
              <Bold />,
              !editor.can().chain().focus().toggleBold().run()
            )}
            {tool(
              "斜体",
              editor.isActive("italic"),
              () => editor.chain().focus().toggleItalic().run(),
              <Italic />,
              !editor.can().chain().focus().toggleItalic().run()
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="更多格式"
                    title="更多格式"
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="rounded-md" align="start">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>文本格式</DropdownMenuLabel>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={
                      !editor.can().chain().focus().toggleUnderline().run()
                    }
                    onClick={() =>
                      editor.chain().focus().toggleUnderline().run()
                    }
                  >
                    <Underline /> 下划线
                    {editor.isActive("underline") && (
                      <Check className="ml-auto" />
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={
                      !editor.can().chain().focus().toggleStrike().run()
                    }
                    onClick={() => editor.chain().focus().toggleStrike().run()}
                  >
                    <Strikethrough /> 删除线
                    {editor.isActive("strike") && <Check className="ml-auto" />}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={!editor.can().chain().focus().toggleCode().run()}
                    onClick={() => editor.chain().focus().toggleCode().run()}
                  >
                    <Code /> 行内代码
                    {editor.isActive("code") && <Check className="ml-auto" />}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={
                      !editor.can().chain().focus().toggleCodeBlock().run()
                    }
                    onClick={() =>
                      editor.chain().focus().toggleCodeBlock().run()
                    }
                  >
                    <FileCode2 /> 代码块
                    {editor.isActive("codeBlock") && (
                      <Check className="ml-auto" />
                    )}
                  </DropdownMenuItem>
                  {aiEnabled && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>高亮颜色</DropdownMenuLabel>
                      <div className="grid grid-cols-5 gap-1 px-2 py-1">
                        {ARTICLE_HIGHLIGHT_COLORS.map((color) => (
                          <Button
                            key={color}
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`高亮颜色 ${color}`}
                            aria-pressed={editor.isActive("highlight", {
                              color,
                            })}
                            title={color}
                            disabled={
                              !editor
                                .can()
                                .chain()
                                .focus()
                                .setHighlight({ color })
                                .run()
                            }
                            onClick={() =>
                              editor
                                .chain()
                                .focus()
                                .setHighlight({ color })
                                .run()
                            }
                          >
                            <span
                              className="size-4 rounded-sm border"
                              style={{ backgroundColor: color }}
                            />
                          </Button>
                        ))}
                      </div>
                      <DropdownMenuItem
                        className="rounded-sm"
                        disabled={
                          !editor.can().chain().focus().unsetHighlight().run()
                        }
                        onClick={() =>
                          editor.chain().focus().unsetHighlight().run()
                        }
                      >
                        <Highlighter /> 清除高亮
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>段落布局</DropdownMenuLabel>
                  {(
                    [
                      ["left", "左对齐", <AlignLeft key="left" />],
                      ["center", "居中", <AlignCenter key="center" />],
                      ["right", "右对齐", <AlignRight key="right" />],
                    ] as const
                  ).map(([alignment, label, icon]) => (
                    <DropdownMenuItem
                      key={alignment}
                      className="rounded-sm"
                      disabled={
                        !editor
                          .can()
                          .chain()
                          .focus()
                          .setTextAlign(alignment)
                          .run()
                      }
                      onClick={() =>
                        editor.chain().focus().setTextAlign(alignment).run()
                      }
                    >
                      {icon} {label}
                      {editor.isActive({ textAlign: alignment }) && (
                        <Check className="ml-auto" />
                      )}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={
                      !editor.can().chain().focus().toggleBlockquote().run()
                    }
                    onClick={() =>
                      editor.chain().focus().toggleBlockquote().run()
                    }
                  >
                    <Quote /> 引用
                    {editor.isActive("blockquote") && (
                      <Check className="ml-auto" />
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={
                      !editor.can().chain().focus().toggleBulletList().run()
                    }
                    onClick={() =>
                      editor.chain().focus().toggleBulletList().run()
                    }
                  >
                    <List /> 无序列表
                    {editor.isActive("bulletList") && (
                      <Check className="ml-auto" />
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={
                      !editor.can().chain().focus().toggleOrderedList().run()
                    }
                    onClick={() =>
                      editor.chain().focus().toggleOrderedList().run()
                    }
                  >
                    <ListOrdered /> 有序列表
                    {editor.isActive("orderedList") && (
                      <Check className="ml-auto" />
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={
                      !editor.can().chain().focus().setHorizontalRule().run()
                    }
                    onClick={() =>
                      editor.chain().focus().setHorizontalRule().run()
                    }
                  >
                    <Minus /> 分隔线
                  </DropdownMenuItem>
                  {editor.isActive("link") && (
                    <DropdownMenuItem
                      className="rounded-sm"
                      onClick={() => editor.chain().focus().unsetLink().run()}
                    >
                      <Unlink /> 移除链接
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={
                      !editor
                        .can()
                        .chain()
                        .focus()
                        .unsetAllMarks()
                        .clearNodes()
                        .run()
                    }
                    onClick={() =>
                      editor.chain().focus().unsetAllMarks().clearNodes().run()
                    }
                  >
                    <Eraser /> 清除全部格式
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Separator orientation="vertical" className="mx-1 h-6" />
            {tool(
              "添加链接",
              editor.isActive("link"),
              openTextLink,
              <Link2 />,
              editor.state.selection.empty && !editor.isActive("link")
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="插入内容"
                    title={
                      mediaEnabled || enhancedEnabled
                        ? "插入内容"
                        : "当前文档没有可用的插入能力"
                    }
                  />
                }
                disabled={!mediaEnabled && !enhancedEnabled}
              >
                <Plus />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="rounded-md">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>媒体</DropdownMenuLabel>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={!mediaEnabled}
                    onClick={() => openInsertMedia("image")}
                  >
                    <Upload /> 图片
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={!mediaEnabled}
                    onClick={() => openInsertMedia("image", true)}
                  >
                    <Upload /> 图库（2-20 张）
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={!mediaEnabled}
                    onClick={() => openInsertMedia("file")}
                  >
                    <Paperclip /> 文件
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={!mediaEnabled}
                    onClick={() => openInsertMedia("audio")}
                  >
                    <Upload /> 音频
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={!mediaEnabled}
                    onClick={() => openInsertMedia("video")}
                  >
                    <Upload /> 视频
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={!mediaEnabled}
                    onClick={() => openMediaDialog("url", "image")}
                  >
                    <Link2 /> 从 URL 导入图片
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={!mediaEnabled}
                    onClick={() => openMediaDialog("library", "image")}
                  >
                    <Library /> 从资产库选择
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>增强卡片</DropdownMenuLabel>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={!enhancedNodes.has("bookmark")}
                    onClick={() => setEnhancedDialog({ type: "bookmark" })}
                  >
                    <PanelTop /> 书签卡片
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={!enhancedNodes.has("button")}
                    onClick={() => setEnhancedDialog({ type: "button" })}
                  >
                    <CreditCard /> CTA 按钮
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    disabled={!enhancedNodes.has("embed")}
                    onClick={() => setEnhancedDialog({ type: "embed" })}
                  >
                    <Video /> 嵌入内容
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant={aiEdit.active ? "secondary" : "ghost"}
                    size="icon-sm"
                    aria-label="AI 编辑"
                    title="AI 编辑"
                  />
                }
              >
                <Sparkles />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="rounded-md" align="start">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>当前内容</DropdownMenuLabel>
                  <DropdownMenuItem
                    className="rounded-sm"
                    onClick={() => void aiEdit.start("rewrite", "block")}
                  >
                    <Sparkles /> 改写当前块
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    onClick={() => void aiEdit.start("polish", "block")}
                  >
                    <Sparkles /> 润色当前块
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    onClick={() => void aiEdit.start("continue", "cursor")}
                  >
                    <Sparkles /> 从光标续写
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>结构化内容</DropdownMenuLabel>
                  <DropdownMenuItem
                    className="rounded-sm"
                    onClick={() => void aiEdit.start("faq", "cursor")}
                  >
                    <Sparkles /> 插入 FAQ
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    onClick={() => void aiEdit.start("cta", "cursor")}
                  >
                    <Sparkles /> 插入 CTA
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>标题与 Meta</DropdownMenuLabel>
                  <DropdownMenuItem
                    className="rounded-sm"
                    onClick={() => void aiEdit.start("title", "metadata")}
                  >
                    <Sparkles /> 生成文章标题
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    onClick={() => void aiEdit.start("meta_title", "metadata")}
                  >
                    <Sparkles /> 生成 Meta title
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-sm"
                    onClick={() =>
                      void aiEdit.start("meta_description", "metadata")
                    }
                  >
                    <Sparkles /> 生成 Meta description
                  </DropdownMenuItem>
                  {aiEdit.active && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="rounded-sm"
                        onClick={aiEdit.openPanel}
                      >
                        <Sparkles /> 查看当前候选
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="ml-auto border-l px-3 text-xs text-muted-foreground tabular-nums">
              {editor.storage.characterCount.characters()} 字
            </span>
            {uploadQueue.tasks.some((task) =>
              ["queued", "initializing", "uploading", "processing"].includes(
                task.status
              )
            ) && (
              <span
                className="px-2 text-xs text-muted-foreground"
                role="status"
              >
                正在处理媒体
              </span>
            )}
          </div>
        </div>
      )}
      {mediaNotice && (
        <div className="border-b bg-amber-50 px-4 py-2 text-sm text-amber-950">
          {mediaNotice}
        </div>
      )}
      <EditorContent
        editor={editor}
        aria-label="文章正文编辑器"
        className="min-h-96 [&_.ProseMirror]:mx-auto [&_.ProseMirror]:min-h-[calc(100dvh-10rem)] [&_.ProseMirror]:max-w-[48rem] [&_.ProseMirror]:px-6 [&_.ProseMirror]:py-8 [&_.ProseMirror]:text-base [&_.ProseMirror]:leading-7 [&_.ProseMirror]:outline-none sm:[&_.ProseMirror]:px-10 sm:[&_.ProseMirror]:py-10 lg:[&_.ProseMirror]:px-12 [&_.ProseMirror_.article-readonly-node]:my-4 [&_.ProseMirror_.article-readonly-node]:rounded-md [&_.ProseMirror_.article-readonly-node]:border [&_.ProseMirror_.article-readonly-node]:bg-muted/40 [&_.ProseMirror_.article-readonly-node]:px-4 [&_.ProseMirror_.article-readonly-node]:py-5 [&_.ProseMirror_.article-readonly-node]:text-sm [&_.ProseMirror_.article-readonly-node]:text-muted-foreground [&_.ProseMirror_.tableWrapper]:my-4 [&_.ProseMirror_.tableWrapper]:max-w-full [&_.ProseMirror_.tableWrapper]:overflow-x-auto [&_.ProseMirror_a]:text-primary [&_.ProseMirror_a]:underline [&_.ProseMirror_aside]:my-4 [&_.ProseMirror_aside]:rounded-md [&_.ProseMirror_aside]:border [&_.ProseMirror_aside]:border-l-4 [&_.ProseMirror_aside]:px-4 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_code]:rounded-sm [&_.ProseMirror_code]:bg-muted [&_.ProseMirror_code]:px-1 [&_.ProseMirror_details]:my-4 [&_.ProseMirror_details]:rounded-md [&_.ProseMirror_details]:border [&_.ProseMirror_details]:px-4 [&_.ProseMirror_details]:py-2 [&_.ProseMirror_h2]:my-4 [&_.ProseMirror_h2]:text-xl [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h3]:my-3 [&_.ProseMirror_h3]:text-lg [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_h4]:my-3 [&_.ProseMirror_h4]:font-semibold [&_.ProseMirror_h5]:my-3 [&_.ProseMirror_h5]:font-semibold [&_.ProseMirror_h6]:my-3 [&_.ProseMirror_h6]:font-semibold [&_.ProseMirror_hr]:my-6 [&_.ProseMirror_mark]:bg-yellow-200 [&_.ProseMirror_ol]:my-3 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-6 [&_.ProseMirror_p]:my-3 [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:rounded-md [&_.ProseMirror_pre]:bg-muted [&_.ProseMirror_pre]:p-3 [&_.ProseMirror_table]:w-full [&_.ProseMirror_table]:min-w-[36rem] [&_.ProseMirror_table]:border-collapse [&_.ProseMirror_td]:border [&_.ProseMirror_td]:px-3 [&_.ProseMirror_td]:align-top [&_.ProseMirror_th]:border [&_.ProseMirror_th]:bg-muted/50 [&_.ProseMirror_th]:px-3 [&_.ProseMirror_th]:text-left [&_.ProseMirror_ul]:my-3 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-6"
      />
      {!readOnly && (
        <ArticleEditorOperationLayer
          editor={editor}
          capabilities={capabilities}
          onOpenLink={openTextLink}
          onMedia={(command) => {
            if (command === "gallery") {
              openInsertMedia("image", true)
              return
            }
            openInsertMedia(command)
          }}
          onEnhanced={(type) => setEnhancedDialog({ type })}
          onAI={
            aiEnabled
              ? (command) => void aiEdit.start(command, "selection")
              : undefined
          }
        />
      )}
      {aiEdit.panel}
      <Input
        ref={fileInputRef}
        type="file"
        className="sr-only !h-px !w-px !p-0"
        tabIndex={-1}
        onChange={(event) => {
          const picker = pendingPicker.current
          const files = Array.from(event.target.files ?? [])
          event.target.value = ""
          pendingPicker.current = null
          if (!picker || files.length === 0) return
          if (
            picker.multiple &&
            picker.intent(0, files.length).kind === "gallery" &&
            (files.length < 2 || files.length > 20)
          ) {
            setMediaNotice("图库必须一次选择 2-20 张图片。")
            return
          }
          setMediaNotice("")
          if (picker.attachUploadId) {
            if (!uploadQueue.attachFile(picker.attachUploadId, files[0])) {
              setMediaNotice("所选文件与原上传任务不一致，请选择原文件。")
            }
            return
          }
          if (picker.replaceUploadId) {
            const previousPosition = findArticleUploadPlaceholder(
              editor,
              picker.replaceUploadId
            )
            const replacement = uploadQueue.replaceFile(
              picker.replaceUploadId,
              files[0]
            )
            if (!replacement) return
            removeArticleUploadPlaceholder(editor, picker.replaceUploadId)
            addArticleUploadPlaceholder(editor, {
              uploadId: replacement.uploadId,
              pos: clampPosition(
                editor,
                previousPosition ?? editor.state.selection.from
              ),
              filename: replacement.filename,
              previewUrl: replacement.previewUrl,
              assetType: replacement.assetType,
            })
            return
          }
          enqueueFiles(
            files,
            picker.intent(0, files.length).kind === "replace"
              ? "replace"
              : "picker",
            editor.state.selection.from,
            picker
          )
        }}
      />
      {mediaDialog && (
        <ArticleMediaDialog
          projectId={projectId}
          mode={mediaDialog.mode}
          assetType={mediaDialog.assetType}
          open
          onOpenChange={(open) => {
            if (!open) setMediaDialog(null)
          }}
          onImportUrl={(url) => {
            const intent = mediaDialog.intent(0, 1)
            const task = uploadQueue.enqueueUrl(
              url,
              mediaDialog.assetType,
              intent
            )
            addTaskPlaceholder(task)
          }}
          onChooseFiles={(files) => {
            const picker: PendingPicker = {
              assetType: mediaDialog.assetType,
              multiple: mediaDialog.multiple,
              intent: mediaDialog.intent,
            }
            const firstIntent = picker.intent(0, files.length)
            enqueueFiles(
              files,
              firstIntent.kind === "replace" ? "replace" : "picker",
              editor.state.selection.from,
              picker
            )
          }}
          onChooseAssets={(assets) => {
            assets.forEach((asset, index) => {
              const baseIntent = mediaDialog.intent(index, assets.length)
              const intent =
                baseIntent.kind === "insert" ||
                baseIntent.kind === "gallery" ||
                baseIntent.kind === "gallery_add"
                  ? {
                      ...baseIntent,
                      alt: asset.default_alt_text ?? undefined,
                      caption: asset.caption ?? undefined,
                    }
                  : baseIntent
              const uploadId = `upl_client_${crypto.randomUUID()}`
              addTaskPlaceholder(
                createArticleLibraryTask({
                  projectId,
                  articleId,
                  asset,
                  intent,
                  uploadId,
                })
              )
              uploadQueue.chooseLibraryAsset(asset, intent, uploadId)
            })
          }}
          assetAccess={assetAccess}
          requestOptions={requestOptions}
          multiple={mediaDialog.multiple}
          minimumSelection={mediaDialog.minimumSelection}
          maximumSelection={mediaDialog.maximumSelection}
        />
      )}
      {pendingImageProperties[0] && (
        <ArticleImagePropertiesDialog
          key={pendingImageProperties[0].task.uploadId}
          open
          asset={pendingImageProperties[0].asset}
          filename={pendingImageProperties[0].task.filename}
          initialAlt={
            pendingImageProperties[0].task.intent.kind === "insert" ||
            pendingImageProperties[0].task.intent.kind === "gallery" ||
            pendingImageProperties[0].task.intent.kind === "gallery_add"
              ? pendingImageProperties[0].task.intent.alt
              : undefined
          }
          initialCaption={
            pendingImageProperties[0].task.intent.kind === "insert" ||
            pendingImageProperties[0].task.intent.kind === "gallery" ||
            pendingImageProperties[0].task.intent.kind === "gallery_add"
              ? pendingImageProperties[0].task.intent.caption
              : undefined
          }
          assetAccess={assetAccess}
          onCancel={() => {
            const pending = pendingImageProperties[0]
            const current = runtimeBridge.getEditor()
            if (current) {
              removeArticleUploadAnchor(current, pending.task)
              removeArticleUploadPlaceholder(current, pending.task.uploadId)
            }
            uploadQueue.discardReady(pending.task.uploadId)
            setPendingImageProperties((items) => items.slice(1))
          }}
          onSubmit={(properties: ArticleImageProperties) => {
            const pending = pendingImageProperties[0]
            const intent = pending.task.intent
            const task = {
              ...pending.task,
              intent:
                intent.kind === "insert" ||
                intent.kind === "gallery" ||
                intent.kind === "gallery_add"
                  ? {
                      ...intent,
                      ...properties,
                      imagePropertiesConfirmed: true,
                    }
                  : intent,
            }
            uploadQueue.applyReadyTask(task, pending.asset)
            setPendingImageProperties((items) => items.slice(1))
          }}
        />
      )}
      {textLink && (
        <ArticleLinkDialog
          open
          value={textLink.value}
          anchorText={textLink.anchorText}
          onOpenChange={(open) => {
            if (!open) setTextLink(null)
          }}
          onSubmit={(value) => {
            editor
              .chain()
              .focus()
              .setTextSelection({ from: textLink.from, to: textLink.to })
              .extendMarkRange("link")
              .setLink(value)
              .run()
            setTextLink(null)
          }}
          onRemove={() => {
            editor
              .chain()
              .focus()
              .setTextSelection({ from: textLink.from, to: textLink.to })
              .extendMarkRange("link")
              .unsetLink()
              .run()
            setTextLink(null)
          }}
        />
      )}
      {enhancedDialog &&
        (() => {
          const located = enhancedDialog.nodeId
            ? findArticleNodeById(editor, enhancedDialog.nodeId)
            : null
          const initial = located
            ? ({ ...located.node.attrs } as Record<string, unknown>)
            : null
          return (
            <ArticleEnhancedCardDialog
              projectId={projectId}
              articleId={articleId}
              type={enhancedDialog.type}
              initial={initial}
              requestOptions={requestOptions}
              onOpenChange={(open) => {
                if (!open) {
                  setEnhancedDialog(null)
                  requestAnimationFrame(() => editor.commands.focus())
                }
              }}
              onSubmit={(submission: ArticleEnhancedCardSubmission) => {
                acceptsUserChanges.current = true
                if (enhancedDialog.nodeId && located) {
                  editor.view.dispatch(
                    editor.state.tr.setNodeMarkup(located.position, undefined, {
                      ...submission.attributes,
                      node_id: enhancedDialog.nodeId,
                    })
                  )
                  return
                }
                editor
                  .chain()
                  .focus()
                  .insertContent({
                    type: submission.type,
                    attrs: {
                      ...submission.attributes,
                      node_id: articleMediaNodeId(submission.type),
                    },
                  })
                  .run()
              }}
              onFallback={(href, label) => {
                acceptsUserChanges.current = true
                if (enhancedDialog.nodeId) {
                  replaceEnhancedCardWithLink(
                    editor,
                    enhancedDialog.nodeId,
                    href,
                    label
                  )
                  return
                }
                const content = articleEnhancedFallbackContent(href, label)
                if (content) editor.chain().focus().insertContent(content).run()
              }}
            />
          )
        })()}
      {pasteReview && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setPasteReview(null)
              requestAnimationFrame(() => editor.commands.focus())
            }
          }}
        >
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>确认粘贴内容</DialogTitle>
              <DialogDescription>
                检测到需要确认的外部内容。只有下方预览中的清洗结果会进入文章。
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              {pasteReview.tables
                .filter((table) => table.clipped)
                .map((table) => (
                  <section key={table.index} className="grid gap-2">
                    <h3 className="text-sm font-medium">
                      表格 {table.index} 超出编辑上限
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      原始 {table.originalRows} 行 × {table.originalColumns}{" "}
                      列，确认后保留前 {table.acceptedRows} 行 ×{" "}
                      {table.acceptedColumns} 列。
                    </p>
                    <div className="overflow-x-auto rounded-md border">
                      <Table className="min-w-full border-collapse text-xs">
                        <TableBody>
                          {table.preview.map((row, rowIndex) => (
                            <TableRow key={rowIndex}>
                              {row.map((cell, columnIndex) => (
                                <TableCell
                                  key={columnIndex}
                                  className="max-w-40 truncate border px-2 py-1"
                                  title={cell}
                                >
                                  {cell || "空单元格"}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </section>
                ))}
              {pasteReview.listDepthExceeded && (
                <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  列表超过 3 层，超出的层级会转为普通段落，文字内容不会丢失。
                </p>
              )}
              {pasteReview.remoteImages.length > 0 && (
                <section className="grid gap-2">
                  <h3 className="text-sm font-medium">网页图片待导入</h3>
                  <p className="text-sm text-muted-foreground">
                    网页图片不会直接引用原站地址。选中的图片将通过平台上传队列导入。
                  </p>
                  <div className="grid max-h-48 gap-2 overflow-y-auto rounded-md border p-3">
                    {pasteReview.remoteImages.map((image, imageIndex) => {
                      const selected =
                        pasteReview.selectedImageIndexes.has(imageIndex)
                      return (
                        <Label
                          key={`${imageIndex}:${image.url}`}
                          className="flex min-w-0 items-start gap-2 text-sm"
                        >
                          <Checkbox
                            checked={selected}
                            disabled={!mediaEnabled}
                            onCheckedChange={(checked) => {
                              setPasteReview((current) => {
                                if (!current) return current
                                const selectedImageIndexes = new Set(
                                  current.selectedImageIndexes
                                )
                                if (checked === true) {
                                  selectedImageIndexes.add(imageIndex)
                                } else {
                                  selectedImageIndexes.delete(imageIndex)
                                }
                                return { ...current, selectedImageIndexes }
                              })
                            }}
                          />
                          <span className="min-w-0">
                            <span className="block break-words">
                              {image.alt || "未提供替代文本"}
                            </span>
                            <span className="block text-xs break-all text-muted-foreground">
                              {image.url}
                            </span>
                          </span>
                        </Label>
                      )
                    })}
                  </div>
                  {!mediaEnabled && (
                    <p className="text-sm text-amber-700" role="status">
                      当前环境尚未开放媒体上传，本次只粘贴文字和表格，图片不会进入文章。
                    </p>
                  )}
                </section>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPasteReview(null)
                  requestAnimationFrame(() => editor.commands.focus())
                }}
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={() => {
                  const from = clampPosition(editor, pasteReview.from)
                  const to = clampPosition(editor, pasteReview.to)
                  const insertion = buildArticlePasteInsertion(
                    pasteReview,
                    pasteReview.selectedImageIndexes,
                    () => articleMediaNodeId("paste_image_anchor")
                  )
                  editor.commands.insertContentAt(
                    {
                      from: Math.min(from, to),
                      to: Math.max(from, to),
                    },
                    insertion.html
                  )
                  for (const remote of insertion.remoteImages) {
                    const image = pasteReview.remoteImages[remote.imageIndex]
                    const anchorPosition = findArticleNodeById(
                      editor,
                      remote.anchorNodeId
                    )?.position
                    if (anchorPosition === undefined) continue
                    const task = uploadQueue.enqueueUrl(image.url, "image", {
                      kind: "insert",
                      nodeType: "image",
                      position: anchorPosition,
                      anchorNodeId: remote.anchorNodeId,
                      alt: image.alt,
                    })
                    addTaskPlaceholder(task)
                  }
                  setPasteReview(null)
                }}
              >
                确认粘贴
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
})
