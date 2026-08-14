import { useEditor, EditorContent } from "@tiptap/react"
import Link from "@tiptap/extension-link"
import StarterKit from "@tiptap/starter-kit"
import {
  Bold,
  Italic,
  Link2,
  List,
  ListOrdered,
  Redo2,
  Undo2,
  Unlink,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  isSafeHttpUrl,
  normalizeDraftDocument,
} from "@/features/outreach/drafts/draft-document"
import type { DraftDocument } from "@/features/outreach/drafts/types"

const extensions = [
  StarterKit.configure({
    blockquote: false,
    code: false,
    codeBlock: false,
    heading: false,
    horizontalRule: false,
    link: false,
    strike: false,
    underline: false,
    trailingNode: false,
  }),
  Link.configure({
    autolink: false,
    linkOnPaste: false,
    openOnClick: false,
    protocols: ["http", "https"],
    isAllowedUri: (url) => isSafeHttpUrl(url),
  }),
]

type DraftEditorProps = {
  initialDocument: DraftDocument
  readOnly: boolean
  onChange(document: DraftDocument): void
}

export function DraftEditor({
  initialDocument,
  readOnly,
  onChange,
}: DraftEditorProps) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: initialDocument,
    editable: !readOnly,
    editorProps: {
      attributes: {
        "aria-label": "邮件正文",
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      onChange(
        normalizeDraftDocument(currentEditor.getJSON(), { allowEmpty: true })
      )
    },
  })

  const setLink = () => {
    if (!editor) return
    const previousHref = editor.getAttributes("link").href
    const href = window.prompt(
      "输入以 http:// 或 https:// 开头的链接",
      typeof previousHref === "string" ? previousHref : "https://"
    )
    if (href === null) return
    if (!isSafeHttpUrl(href)) {
      window.alert("链接必须是完整的 HTTP 或 HTTPS 地址。")
      return
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run()
  }

  if (!editor) {
    return (
      <div className="min-h-72 bg-muted/30" aria-label="草稿编辑器加载中" />
    )
  }

  const tool = (
    label: string,
    active: boolean,
    action: () => void,
    icon: React.ReactNode,
    disabled = false
  ) => (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon-sm"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={action}
    >
      {icon}
    </Button>
  )

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      {!readOnly && (
        <div className="flex min-h-11 flex-wrap items-center gap-1 border-b bg-muted/30 px-2 py-1.5">
          {tool(
            "粗体",
            editor.isActive("bold"),
            () => editor.chain().focus().toggleBold().run(),
            <Bold />
          )}
          {tool(
            "斜体",
            editor.isActive("italic"),
            () => editor.chain().focus().toggleItalic().run(),
            <Italic />
          )}
          <Separator orientation="vertical" className="mx-1 h-6" />
          {tool(
            "无序列表",
            editor.isActive("bulletList"),
            () => editor.chain().focus().toggleBulletList().run(),
            <List />
          )}
          {tool(
            "有序列表",
            editor.isActive("orderedList"),
            () => editor.chain().focus().toggleOrderedList().run(),
            <ListOrdered />
          )}
          <Separator orientation="vertical" className="mx-1 h-6" />
          {tool(
            "添加链接",
            editor.isActive("link"),
            setLink,
            <Link2 />,
            editor.state.selection.empty
          )}
          {tool(
            "移除链接",
            false,
            () => editor.chain().focus().unsetLink().run(),
            <Unlink />,
            !editor.isActive("link")
          )}
          <Separator orientation="vertical" className="mx-1 h-6" />
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
        </div>
      )}
      <EditorContent
        editor={editor}
        className="min-h-72 [&_.ProseMirror]:min-h-72 [&_.ProseMirror]:px-4 [&_.ProseMirror]:py-3 [&_.ProseMirror]:text-sm [&_.ProseMirror]:leading-6 [&_.ProseMirror]:outline-none [&_.ProseMirror_a]:text-primary [&_.ProseMirror_a]:underline [&_.ProseMirror_ol]:my-3 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-6 [&_.ProseMirror_p]:my-2 [&_.ProseMirror_ul]:my-3 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-6"
      />
    </div>
  )
}
