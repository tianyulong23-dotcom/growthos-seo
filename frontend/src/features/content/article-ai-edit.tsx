import type { Editor } from "@tiptap/core"
import { Fragment, Slice } from "@tiptap/pm/model"
import type { Transaction } from "@tiptap/pm/state"
import * as React from "react"
import {
  AlertTriangle,
  Check,
  CircleStop,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react"

import { ApiError } from "@/api/client"
import {
  acceptArticleAIEdit,
  cancelArticleAIEdit,
  createArticleAIEdit,
  getArticleAIEdit,
  rejectArticleAIEdit,
  retryArticleAIEdit,
  subscribeArticleAIEdit,
  type ArticleAIEditAcceptMode,
  type ArticleAIEditCommand,
  type ArticleAIEditOperation,
  type ArticleAIEditScope,
  type ArticleAIEditSelection,
  type ArticleMetadataSnapshot,
  type ArticleRequestOptions,
  type ArticleSeoFieldKey,
} from "@/api/articles"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  articleSnapshotHash,
  editorJsonToArticleDocument,
} from "@/features/content/article-document"
import {
  articleAIEditDecorationKey,
  setArticleAIEditDecoration,
} from "@/features/content/article-ai-edit-extension"
import {
  plainTextOffsetToProseMirror,
  proseMirrorOffsetToPlainText,
  textblockPlainText,
} from "@/features/content/article-ai-edit-selection"
import { findArticleNodeById } from "@/features/content/article-media-editor"

const ACTIVE_STATUSES = new Set(["queued", "streaming"])
const TERMINAL_STREAM_STATUSES = new Set([
  "ready",
  "accepted",
  "rejected",
  "cancelled",
  "failed",
  "stale",
])

const COMMAND_LABELS: Record<ArticleAIEditCommand, string> = {
  rewrite: "改写",
  polish: "润色",
  shorten: "缩短",
  expand: "扩写",
  proofread: "校对",
  translate: "翻译",
  continue: "续写",
  title: "文章标题",
  meta_title: "Meta title",
  meta_description: "Meta description",
  faq: "FAQ",
  cta: "CTA",
}

const STATUS_LABELS: Record<ArticleAIEditOperation["status"], string> = {
  queued: "排队中",
  streaming: "生成中",
  ready: "待处理",
  accepted: "已接受",
  rejected: "已拒绝",
  cancelled: "已取消",
  failed: "失败",
  stale: "已过期",
}

type Anchor = {
  nodeId: string
  nodePosition: number
  text: string
  from: number
  to: number
  absoluteFrom: number
  absoluteTo: number
}

type AIEditSession = {
  operation: ArticleAIEditOperation
  originalText: string
  streamInterrupted: boolean
  documentDrifted: boolean
}

type AIEditControllerInput = {
  editor: Editor | null
  projectId: string
  articleId: string
  reviewVersion: number
  metadata: ArticleMetadataSnapshot
  requestOptions?: Omit<ArticleRequestOptions, "signal">
  onBeforeDocumentAccept: () => void
  onMetadataAccept: (field: ArticleSeoFieldKey, value: string) => void
}

function operationError(error: unknown) {
  if (error instanceof ApiError) {
    const labels: Record<string, string> = {
      ai_edit_concurrency_limit: "同时进行的 AI 操作过多，请先处理已有候选。",
      ai_edit_rate_limit: "本小时 AI 编辑次数已达上限。",
      ai_edit_quota_exhausted: "本月 AI 编辑额度已用完。",
      ai_edit_document_stale: "正文已经变化，旧候选不能覆盖当前内容。",
      ai_edit_selection_stale: "原选区已经变化，旧候选不能覆盖当前内容。",
      ai_edit_review_version_stale: "文章审核版本已经变化，请重新生成候选。",
      ai_edit_stale: "候选基线已经过期，请基于当前正文重试。",
      ai_edit_provider_not_configured: "AI 服务尚未配置。",
      ai_edit_provider_timeout: "AI 服务响应超时，可重试本次操作。",
      ai_edit_provider_rate_limited: "AI 服务暂时限流，可稍后重试。",
    }
    return (error.code && labels[error.code]) || error.message
  }
  return error instanceof Error ? error.message : "AI 编辑操作失败"
}

function selectedNode(editor: Editor, from: number, to: number): Anchor | null {
  let result: Anchor | null = null
  editor.state.doc.descendants((node, position) => {
    if (result || !node.isTextblock) return
    const nodeId = node.attrs.node_id
    if (typeof nodeId !== "string" || !nodeId) return
    const start = position + 1
    const end = start + node.content.size
    if (from < start || to > end) return
    result = {
      nodeId,
      nodePosition: position,
      text: textblockPlainText(node),
      from: proseMirrorOffsetToPlainText(node, from - start),
      to: proseMirrorOffsetToPlainText(node, to - start),
      absoluteFrom: from,
      absoluteTo: to,
    }
  })
  return result
}

async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("")
}

async function selectionForCommand(
  editor: Editor,
  scope: ArticleAIEditScope
): Promise<{ selection: ArticleAIEditSelection; anchor: Anchor } | null> {
  const current = editor.state.selection
  if (scope === "metadata") return null
  const cursor = scope === "cursor" ? current.to : current.from
  const anchor = selectedNode(
    editor,
    scope === "cursor" ? cursor : current.from,
    scope === "cursor" ? cursor : current.to
  )
  if (!anchor) return null
  if (scope === "selection" && current.empty) return null

  const from = scope === "block" ? 0 : anchor.from
  const to = scope === "block" ? anchor.text.length : anchor.to
  const selected = anchor.text.slice(from, to)
  const located = findArticleNodeById(editor, anchor.nodeId)
  if (!located || !located.node.isTextblock) return null
  const absoluteFrom =
    anchor.nodePosition + 1 + plainTextOffsetToProseMirror(located.node, from)
  const absoluteTo =
    anchor.nodePosition + 1 + plainTextOffsetToProseMirror(located.node, to)
  return {
    selection: {
      anchor_node_id: anchor.nodeId,
      from,
      to,
      selected_text_hash: await sha256Text(selected),
    },
    anchor: {
      ...anchor,
      from,
      to,
      absoluteFrom,
      absoluteTo,
      text: selected,
    },
  }
}

function headingPath(editor: Editor, before: number) {
  const path: string[] = []
  editor.state.doc.descendants((node, position) => {
    if (position >= before) return false
    if (node.type.name !== "heading") return
    const level = Number(node.attrs.level)
    if (!Number.isInteger(level)) return
    path.splice(Math.max(0, level - 2))
    path[Math.max(0, level - 2)] = node.textContent
  })
  return path.filter(Boolean).slice(-8)
}

function currentDocument(editor: Editor) {
  return editorJsonToArticleDocument(editor.getJSON())
}

async function currentSelection(
  editor: Editor,
  operation: ArticleAIEditOperation
): Promise<{
  selection: ArticleAIEditSelection | null
  from: number
  to: number
}> {
  const baseline = operation.selection
  if (!baseline) return { selection: null, from: 0, to: 0 }
  const located = findArticleNodeById(editor, baseline.anchor_node_id)
  if (!located || !located.node.isTextblock) {
    return { selection: null, from: 0, to: 0 }
  }
  let fromOffset: number
  let toOffset: number
  try {
    fromOffset = plainTextOffsetToProseMirror(located.node, baseline.from)
    toOffset = plainTextOffsetToProseMirror(located.node, baseline.to)
  } catch {
    return { selection: null, from: 0, to: 0 }
  }
  const text = textblockPlainText(located.node).slice(
    baseline.from,
    baseline.to
  )
  return {
    selection: {
      ...baseline,
      selected_text_hash: await sha256Text(text),
    },
    from: located.position + 1 + fromOffset,
    to: located.position + 1 + toOffset,
  }
}

function textFragment(editor: Editor, value: string) {
  const nodes = value.split("\n").flatMap((line, index, lines) => {
    const result = line ? [editor.schema.text(line)] : []
    if (index < lines.length - 1)
      result.push(editor.schema.nodes.hardBreak.create())
    return result
  })
  return Fragment.fromArray(nodes)
}

function applyAcceptedDocument(
  editor: Editor,
  operation: ArticleAIEditOperation,
  mode: ArticleAIEditAcceptMode,
  response: Awaited<ReturnType<typeof acceptArticleAIEdit>>,
  range: { from: number; to: number }
) {
  let transaction: Transaction = editor.state.tr
  if (response.canonical_slice?.content) {
    const nodes = response.canonical_slice.content.map((node) =>
      editor.schema.nodeFromJSON(node)
    )
    const fragment = Fragment.fromArray(nodes)
    transaction =
      mode === "replace"
        ? transaction.replaceRange(
            range.from,
            range.to,
            new Slice(fragment, 0, 0)
          )
        : transaction.insert(range.to, fragment)
  } else {
    const accepted = response.operation.accepted_result as {
      text?: unknown
    } | null
    const text = typeof accepted?.text === "string" ? accepted.text : ""
    if (!text) throw new Error("AI 接受响应缺少正文候选")
    const from = mode === "replace" ? range.from : range.to
    const to = mode === "replace" ? range.to : range.to
    transaction = transaction.replaceWith(from, to, textFragment(editor, text))
  }
  transaction = transaction
    .setMeta(articleAIEditDecorationKey, null)
    .setMeta("articleAIEditOperationId", operation.id)
    .scrollIntoView()
  editor.view.dispatch(transaction)
}

function acceptedDocumentRange(
  editor: Editor,
  response: Awaited<ReturnType<typeof acceptArticleAIEdit>>,
  mode: ArticleAIEditAcceptMode
) {
  if (
    !response.anchor_node_id ||
    response.from === null ||
    response.to === null
  ) {
    throw new Error("AI 接受响应缺少服务端确认的正文范围")
  }
  const located = findArticleNodeById(editor, response.anchor_node_id)
  if (!located || !located.node.isTextblock) {
    throw new Error("AI 接受响应对应的正文范围已不存在")
  }
  const from =
    located.position +
    1 +
    plainTextOffsetToProseMirror(located.node, response.from)
  const to =
    located.position +
    1 +
    plainTextOffsetToProseMirror(located.node, response.to)
  if (response.canonical_slice?.content && mode === "insert_after") {
    return { from, to: located.position + located.node.nodeSize }
  }
  return { from, to }
}

export function useArticleAIEditController(input: AIEditControllerInput) {
  const [session, setSession] = React.useState<AIEditSession | null>(null)
  const [open, setOpen] = React.useState(false)
  const [error, setError] = React.useState("")
  const [working, setWorking] = React.useState(false)
  const [candidateIndex, setCandidateIndex] = React.useState(0)
  const streamCleanup = React.useRef<(() => void) | null>(null)
  const streamDescriptor = React.useRef<{
    stream_endpoint: string
    stream_token: string
  } | null>(null)
  const appliedOperations = React.useRef(new Set<string>())
  const acceptKeys = React.useRef(new Map<string, string>())

  const updateOperation = React.useCallback(
    (operation: ArticleAIEditOperation) => {
      setSession((current) =>
        current
          ? { ...current, operation, streamInterrupted: false }
          : {
              operation,
              originalText: "",
              streamInterrupted: false,
              documentDrifted: false,
            }
      )
      if (TERMINAL_STREAM_STATUSES.has(operation.status)) {
        streamCleanup.current?.()
        streamCleanup.current = null
        streamDescriptor.current = null
      }
    },
    []
  )

  const connectStream = React.useCallback(() => {
    const descriptor = streamDescriptor.current
    if (!descriptor) return
    streamCleanup.current?.()
    streamCleanup.current = subscribeArticleAIEdit(descriptor, {
      onOperation: updateOperation,
      onError: () => {
        streamCleanup.current = null
        setSession((current) =>
          current ? { ...current, streamInterrupted: true } : current
        )
      },
    })
  }, [updateOperation])

  React.useEffect(
    () => () => {
      streamCleanup.current?.()
      streamCleanup.current = null
      streamDescriptor.current = null
    },
    []
  )

  React.useEffect(() => {
    const editor = input.editor
    if (!editor) return
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return
      setSession((current) => {
        if (
          !current ||
          !["queued", "streaming", "ready"].includes(current.operation.status)
        ) {
          return current
        }
        const baseline = current.operation.selection
        if (baseline) {
          const located = findArticleNodeById(editor, baseline.anchor_node_id)
          try {
            if (!located || !located.node.isTextblock) throw new Error()
            const from = plainTextOffsetToProseMirror(
              located.node,
              baseline.from
            )
            const to = plainTextOffsetToProseMirror(located.node, baseline.to)
            setArticleAIEditDecoration(editor, {
              from: located.position + 1 + from,
              to: located.position + 1 + to,
              stale: true,
            })
          } catch {
            setArticleAIEditDecoration(editor, null)
          }
        }
        return current.documentDrifted
          ? current
          : { ...current, documentDrifted: true }
      })
    }
    editor.on("transaction", onTransaction)
    return () => {
      editor.off("transaction", onTransaction)
    }
  }, [input.editor])

  const start = React.useCallback(
    async (command: ArticleAIEditCommand, scope: ArticleAIEditScope) => {
      const editor = input.editor
      if (!editor || editor.isDestroyed) return
      if (session && ACTIVE_STATUSES.has(session.operation.status)) {
        setOpen(true)
        setError("当前 AI 操作仍在生成，请先取消或等待完成。")
        return
      }
      if (session?.operation.status === "ready") {
        setOpen(true)
        setError("请先接受或拒绝当前候选，再发起新操作。")
        return
      }
      setOpen(true)
      setWorking(true)
      setError("")
      try {
        const captured = await selectionForCommand(editor, scope)
        if (scope !== "metadata" && !captured) {
          throw new Error(
            scope === "selection"
              ? "请选择同一内容块内的文字后再使用 AI。"
              : "当前光标不在可编辑的文本块内。"
          )
        }
        const document = currentDocument(editor)
        const documentHash = await articleSnapshotHash(document, input.metadata)
        const response = await createArticleAIEdit(
          input.projectId,
          input.articleId,
          {
            base_review_version: input.reviewVersion,
            document_hash: documentHash,
            document,
            metadata: input.metadata,
            command,
            scope,
            selection: captured?.selection ?? null,
            context: {
              heading_path: headingPath(
                editor,
                captured?.anchor.absoluteFrom ?? editor.state.selection.from
              ),
              focus_keyword: input.metadata.focus_keyword,
              locale: "zh-CN",
              target_locale: command === "translate" ? "en" : null,
              brand_terms: [],
            },
          },
          crypto.randomUUID(),
          input.requestOptions
        )
        setCandidateIndex(0)
        setSession({
          operation: response.operation,
          originalText: captured?.anchor.text ?? "",
          streamInterrupted: false,
          documentDrifted: false,
        })
        if (
          captured &&
          captured.anchor.absoluteFrom < captured.anchor.absoluteTo
        ) {
          setArticleAIEditDecoration(editor, {
            from: captured.anchor.absoluteFrom,
            to: captured.anchor.absoluteTo,
          })
        } else {
          setArticleAIEditDecoration(editor, null)
        }
        if (ACTIVE_STATUSES.has(response.operation.status)) {
          streamDescriptor.current = {
            stream_endpoint: response.stream_endpoint,
            stream_token: response.stream_token,
          }
          connectStream()
        }
      } catch (requestError) {
        setError(operationError(requestError))
      } finally {
        setWorking(false)
      }
    },
    [connectStream, input, session]
  )

  const cancel = React.useCallback(async () => {
    if (!session || !ACTIVE_STATUSES.has(session.operation.status)) return
    setWorking(true)
    setError("")
    try {
      updateOperation(
        await cancelArticleAIEdit(
          input.projectId,
          input.articleId,
          session.operation.id,
          input.requestOptions
        )
      )
      if (input.editor) setArticleAIEditDecoration(input.editor, null)
    } catch (requestError) {
      setError(operationError(requestError))
    } finally {
      setWorking(false)
    }
  }, [input, session, updateOperation])

  const reject = React.useCallback(async () => {
    if (!session || session.operation.status !== "ready") return
    setWorking(true)
    setError("")
    try {
      updateOperation(
        await rejectArticleAIEdit(
          input.projectId,
          input.articleId,
          session.operation.id,
          null,
          input.requestOptions
        )
      )
      if (input.editor) setArticleAIEditDecoration(input.editor, null)
    } catch (requestError) {
      setError(operationError(requestError))
    } finally {
      setWorking(false)
    }
  }, [input, session, updateOperation])

  const retry = React.useCallback(async () => {
    const editor = input.editor
    if (!editor || !session) return
    setWorking(true)
    setError("")
    try {
      const captured = await selectionForCommand(
        editor,
        session.operation.scope
      )
      if (session.operation.scope !== "metadata" && !captured) {
        throw new Error("请在当前正文中重新选择有效范围后重试。")
      }
      const document = currentDocument(editor)
      const documentHash = await articleSnapshotHash(document, input.metadata)
      const response = await retryArticleAIEdit(
        input.projectId,
        input.articleId,
        session.operation.id,
        {
          base_review_version: input.reviewVersion,
          document_hash: documentHash,
          document,
          metadata: input.metadata,
          selection: captured?.selection ?? null,
          context: {
            heading_path: headingPath(
              editor,
              captured?.anchor.absoluteFrom ?? editor.state.selection.from
            ),
            focus_keyword: input.metadata.focus_keyword,
            locale: "zh-CN",
            target_locale:
              session.operation.command === "translate" ? "en" : null,
            brand_terms: [],
          },
          reason: session.operation.error_code,
        },
        crypto.randomUUID(),
        input.requestOptions
      )
      setCandidateIndex(0)
      setSession({
        operation: response.operation,
        originalText: captured?.anchor.text ?? "",
        streamInterrupted: false,
        documentDrifted: false,
      })
      if (
        captured &&
        captured.anchor.absoluteFrom < captured.anchor.absoluteTo
      ) {
        setArticleAIEditDecoration(editor, {
          from: captured.anchor.absoluteFrom,
          to: captured.anchor.absoluteTo,
        })
      } else {
        setArticleAIEditDecoration(editor, null)
      }
      streamDescriptor.current = {
        stream_endpoint: response.stream_endpoint,
        stream_token: response.stream_token,
      }
      if (ACTIVE_STATUSES.has(response.operation.status)) connectStream()
    } catch (requestError) {
      setError(operationError(requestError))
    } finally {
      setWorking(false)
    }
  }, [connectStream, input, session])

  const accept = React.useCallback(
    async (mode: ArticleAIEditAcceptMode) => {
      const editor = input.editor
      if (!editor || !session || session.operation.status !== "ready") return
      setWorking(true)
      setError("")
      try {
        const document = currentDocument(editor)
        const documentHash = await articleSnapshotHash(document, input.metadata)
        const selected = await currentSelection(editor, session.operation)
        let key = acceptKeys.current.get(session.operation.id)
        if (!key) {
          key = crypto.randomUUID()
          acceptKeys.current.set(session.operation.id, key)
        }
        const response = await acceptArticleAIEdit(
          input.projectId,
          input.articleId,
          session.operation.id,
          {
            current_review_version: input.reviewVersion,
            current_document_hash: documentHash,
            current_document: document,
            current_metadata: input.metadata,
            current_selection: selected.selection,
            mode,
            candidate_index:
              session.operation.candidate.kind === "metadata"
                ? candidateIndex
                : null,
          },
          key,
          input.requestOptions
        )
        if (!appliedOperations.current.has(response.operation.id)) {
          if (response.canonical_metadata) {
            const field = response.canonical_metadata.field
            const value = response.canonical_metadata.value
            if (
              (field === "title" ||
                field === "meta_title" ||
                field === "meta_description") &&
              typeof value === "string"
            ) {
              input.onMetadataAccept(field, value)
            } else {
              throw new Error("AI 接受响应缺少有效的 Metadata 候选")
            }
          } else {
            input.onBeforeDocumentAccept()
            applyAcceptedDocument(
              editor,
              session.operation,
              mode,
              response,
              acceptedDocumentRange(editor, response, mode)
            )
          }
          appliedOperations.current.add(response.operation.id)
        }
        updateOperation(response.operation)
      } catch (requestError) {
        if (requestError instanceof ApiError && requestError.status === 409) {
          try {
            updateOperation(
              await getArticleAIEdit(
                input.projectId,
                input.articleId,
                session.operation.id,
                input.requestOptions
              )
            )
          } catch {
            // Preserve the authoritative accept error if refresh also fails.
          }
        }
        setError(operationError(requestError))
      } finally {
        setWorking(false)
      }
    },
    [candidateIndex, input, session, updateOperation]
  )

  const operation = session?.operation ?? null
  const allowedMode = operation?.allowed_modes[0] ?? null
  const metadataCandidates = operation?.candidate.metadata?.candidates ?? []
  const candidateText =
    operation?.candidate.kind === "text"
      ? operation.candidate.text
      : operation?.candidate.kind === "slice"
        ? JSON.stringify(operation.candidate.slice, null, 2)
        : (metadataCandidates[candidateIndex] ?? "")

  const panel = (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className="w-full sm:max-w-xl" aria-label="AI 编辑候选">
        <SheetHeader className="border-b">
          <div className="flex items-center gap-2 pr-10">
            <Sparkles className="size-4" />
            <SheetTitle>AI 编辑候选</SheetTitle>
            {operation && (
              <Badge variant="outline">{STATUS_LABELS[operation.status]}</Badge>
            )}
          </div>
          <SheetDescription>
            候选接受前不会修改正文，也不会进入自动保存。
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {!operation && !working && (
            <p className="text-sm text-muted-foreground">
              从选区、当前块或标题与 Meta 菜单发起 AI 编辑。
            </p>
          )}
          {(working ||
            (operation && ACTIVE_STATUSES.has(operation.status))) && (
            <div className="flex items-center gap-2 text-sm" role="status">
              <LoaderCircle className="size-4 animate-spin" />
              {operation ? STATUS_LABELS[operation.status] : "正在创建操作"}
            </div>
          )}
          {operation && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-muted-foreground">命令</p>
                  <p className="mt-1 font-medium">
                    {COMMAND_LABELS[operation.command]}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">模型</p>
                  <p className="mt-1 truncate font-medium">
                    {operation.model ?? operation.provider ?? "等待分配"}
                  </p>
                </div>
              </div>
              {session?.documentDrifted && operation.status === "ready" && (
                <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    候选生成后正文发生过变化。接受时服务端会校验全文和原选区，过期候选不会覆盖新内容。
                  </span>
                </div>
              )}
              {session?.streamInterrupted &&
                ACTIVE_STATUSES.has(operation.status) && (
                  <div className="rounded-md border p-3 text-sm">
                    <p>候选流已中断，服务端操作仍可能继续。</p>
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="outline"
                      onClick={connectStream}
                    >
                      <RefreshCw /> 重新连接
                    </Button>
                  </div>
                )}
              {(operation.candidate.text ||
                operation.candidate.slice ||
                metadataCandidates.length > 0) && (
                <>
                  {metadataCandidates.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">
                        选择一个候选
                      </p>
                      {metadataCandidates.map((candidate, index) => (
                        <Button
                          type="button"
                          key={`${candidate}:${index}`}
                          variant="outline"
                          className="h-auto w-full justify-start gap-3 rounded-md p-3 text-left text-sm whitespace-normal hover:bg-muted/40"
                          data-selected={candidateIndex === index}
                          aria-pressed={candidateIndex === index}
                          onClick={() => setCandidateIndex(index)}
                        >
                          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border">
                            {candidateIndex === index && (
                              <Check className="size-3" />
                            )}
                          </span>
                          <span>{candidate}</span>
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="min-w-0">
                        <p className="mb-2 text-xs font-medium text-muted-foreground">
                          原内容
                        </p>
                        <div className="max-h-72 overflow-auto rounded-md border bg-muted/20 p-3 text-sm whitespace-pre-wrap">
                          {session?.originalText || "（插入位置）"}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <p className="mb-2 text-xs font-medium text-muted-foreground">
                          AI 候选
                        </p>
                        <div className="max-h-72 overflow-auto rounded-md border p-3 text-sm whitespace-pre-wrap">
                          {candidateText || "正在生成..."}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
              {operation.error_code && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  {operation.error_detail || operation.error_code}
                </div>
              )}
              <Separator />
              <div className="grid grid-cols-3 gap-3 text-xs text-muted-foreground">
                <span>输入 {operation.input_tokens}</span>
                <span>输出 {operation.output_tokens}</span>
                <span>
                  {operation.latency_ms == null
                    ? "耗时 -"
                    : `耗时 ${operation.latency_ms} ms`}
                </span>
              </div>
            </div>
          )}
          {error && (
            <div
              className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              {error}
            </div>
          )}
        </div>
        {operation && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t p-4">
            {ACTIVE_STATUSES.has(operation.status) && (
              <Button variant="outline" disabled={working} onClick={cancel}>
                <CircleStop /> 取消生成
              </Button>
            )}
            {operation.status === "ready" && (
              <>
                <Button variant="outline" disabled={working} onClick={reject}>
                  <X /> 拒绝
                </Button>
                {operation.allowed_modes.map((mode) => (
                  <Button
                    key={mode}
                    disabled={
                      working || (mode === "apply_metadata" && !candidateText)
                    }
                    onClick={() => void accept(mode)}
                  >
                    <Check />
                    {mode === "replace"
                      ? "接受替换"
                      : mode === "insert_after"
                        ? "接受插入"
                        : "应用字段"}
                  </Button>
                ))}
              </>
            )}
            {["failed", "cancelled", "stale", "rejected"].includes(
              operation.status
            ) && (
              <Button disabled={working} onClick={retry}>
                <RotateCcw /> 基于当前正文重试
              </Button>
            )}
            {operation.status === "accepted" && allowedMode && (
              <span className="text-sm text-muted-foreground">
                已作为一次受控操作应用，可使用编辑器撤销。
              </span>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )

  return {
    start,
    openPanel: () => setOpen(true),
    active: Boolean(operation),
    panel,
  }
}
