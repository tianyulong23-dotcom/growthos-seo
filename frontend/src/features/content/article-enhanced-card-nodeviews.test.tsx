import { Editor, type JSONContent } from "@tiptap/core"
import { EditorContent } from "@tiptap/react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createArticleEditorExtensions } from "@/features/content/article-editor-extensions"
import type { ArticleEnhancedCardRuntimeStorage } from "@/features/content/article-enhanced-card-nodeviews"

function renderEnhancedNode(
  node: JSONContent,
  options: { readOnly?: boolean; selected?: boolean } = {}
) {
  const runtime: ArticleEnhancedCardRuntimeStorage = {
    readOnly: Boolean(options.readOnly),
    open: vi.fn(),
    refreshBookmark: vi.fn(),
    fallback: vi.fn(() => true),
  }
  const editor = new Editor({
    extensions: createArticleEditorExtensions({ enhancedRuntime: runtime }),
    editable: !options.readOnly,
    content: { type: "doc", content: [node] },
  })
  if (options.selected) editor.commands.setNodeSelection(0)
  const rendered = render(<EditorContent editor={editor} />)
  return {
    ...rendered,
    editor,
    runtime,
    destroy() {
      rendered.unmount()
      editor.destroy()
    },
  }
}

afterEach(cleanup)

describe("article enhanced card node views", () => {
  it("does not throw for malformed legacy bookmark URLs", () => {
    const view = renderEnhancedNode({
      type: "bookmark",
      attrs: {
        node_id: "bookmark-invalid",
        url: "not a valid URL",
        title: null,
      },
    })

    expect(screen.getByText("链接地址不可用")).toBeTruthy()
    view.destroy()
  })

  it("hides failed external bookmark icon and cover images", async () => {
    const view = renderEnhancedNode({
      type: "bookmark",
      attrs: {
        node_id: "bookmark-images",
        url: "https://example.com/source",
        title: "Source",
        icon_url: "https://example.com/icon.png",
        image_url: "https://example.com/cover.jpg",
      },
    })
    const images = Array.from(view.container.querySelectorAll("img"))
    expect(images).toHaveLength(2)

    images.forEach((image) => fireEvent.error(image))
    await waitFor(() => expect(view.container.querySelectorAll("img")).toHaveLength(0))
    view.destroy()
  })

  it("hides edit, refresh, fallback and delete actions in read-only mode", () => {
    const view = renderEnhancedNode(
      {
        type: "bookmark",
        attrs: {
          node_id: "bookmark-readonly",
          url: "https://example.com/source",
          title: "Read-only source",
        },
      },
      { readOnly: true, selected: true }
    )

    expect(screen.queryByRole("button", { name: /编辑/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /刷新元数据/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /转为普通链接/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /删除卡片/ })).toBeNull()
    view.destroy()
  })

  it("renders iframe sources only through the controlled provider mapping", () => {
    const trusted = renderEnhancedNode({
      type: "embed",
      attrs: {
        node_id: "embed-youtube",
        provider: "youtube",
        source_url: "https://youtu.be/abc123",
        embed_id: "abc123",
      },
    })
    expect(trusted.container.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/abc123"
    )
    trusted.destroy()

    const rejected = renderEnhancedNode({
      type: "embed",
      attrs: {
        node_id: "embed-rejected",
        provider: "https://evil.example",
        source_url: "https://evil.example/payload",
        embed_id: "payload123",
      },
    })
    expect(rejected.container.querySelector("iframe")).toBeNull()
    expect(screen.getByText("嵌入不可用")).toBeTruthy()
    rejected.destroy()
  })

  it("routes selected card actions through the shared runtime", () => {
    const view = renderEnhancedNode(
      {
        type: "button",
        attrs: {
          node_id: "button-1",
          label: "Read report",
          href: "/report",
          style: "primary",
        },
      },
      { selected: true }
    )

    fireEvent.click(screen.getByRole("button", { name: /编辑/ }))
    expect(view.runtime.open).toHaveBeenCalledWith("button", "button-1")
    view.destroy()
  })
})
