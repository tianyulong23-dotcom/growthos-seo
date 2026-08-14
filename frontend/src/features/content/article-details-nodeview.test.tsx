import { Editor, type JSONContent } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { EditorContent } from "@tiptap/react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import {
  ARTICLE_DETAILS_SUMMARY_MAX_LENGTH,
  normalizeArticleDetailsSummary,
  validateArticleDetailsSummary,
} from "@/features/content/article-details"
import { articleEditorCommands } from "@/features/content/article-editor-commands"
import { articleEditorExtensions } from "@/features/content/article-editor-extensions"

function detailsEditor(editable = true, withSibling = false) {
  return new Editor({
    extensions: articleEditorExtensions,
    editable,
    content: {
      type: "doc",
      content: [
        ...(withSibling
          ? [
              {
                type: "paragraph",
                attrs: { node_id: "before-1" },
                content: [{ type: "text", text: "Before" }],
              },
            ]
          : []),
        {
          type: "details",
          attrs: {
            node_id: "details-1",
            summary: "Common question",
            open_by_default: true,
          },
          content: [
            {
              type: "detailsContent",
              content: [
                {
                  type: "paragraph",
                  attrs: { node_id: "details-p-1" },
                  content: [{ type: "text", text: "First paragraph" }],
                },
                {
                  type: "orderedList",
                  attrs: { node_id: "details-list-1", start: 1 },
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          attrs: { node_id: "details-p-2" },
                          content: [{ type: "text", text: "List item" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  })
}

afterEach(cleanup)

describe("article details node view", () => {
  it("renders structured body and separates preview state from publish default", async () => {
    const editor = detailsEditor()
    const { container, unmount } = render(<EditorContent editor={editor} />)

    await screen.findByRole("toolbar", { name: "折叠内容工具栏" })
    const content = container.querySelector<HTMLElement>(
      ".article-details-content"
    )
    expect(content?.hidden).toBe(false)
    expect(content?.querySelectorAll("p")).toHaveLength(2)
    expect(content?.querySelector("ol")?.textContent).toContain("List item")

    fireEvent.click(screen.getByRole("button", { name: "收起折叠内容" }))
    expect(content?.hidden).toBe(true)
    expect(editor.getJSON().content?.[0].attrs?.open_by_default).toBe(true)

    fireEvent.click(screen.getByRole("switch", { name: "发布后默认展开" }))
    await waitFor(() =>
      expect(editor.getJSON().content?.[0].attrs?.open_by_default).toBe(false)
    )
    expect(content?.hidden).toBe(true)

    unmount()
    editor.destroy()
  })

  it("keeps invalid summary drafts out of the document and commits trimmed text", async () => {
    const editor = detailsEditor()
    const { unmount } = render(<EditorContent editor={editor} />)
    const input = await screen.findByRole("textbox", { name: "折叠内容摘要" })

    fireEvent.change(input, { target: { value: "   " } })
    expect(screen.getByRole("alert").textContent).toContain("摘要不能为空")
    expect(editor.getJSON().content?.[0].attrs?.summary).toBe("Common question")

    fireEvent.change(input, { target: { value: "  Updated question  " } })
    await waitFor(() =>
      expect(editor.getJSON().content?.[0].attrs?.summary).toBe(
        "Updated question"
      )
    )
    expect(screen.queryByRole("alert")).toBeNull()

    unmount()
    editor.destroy()
  })

  it("opens and moves focus into the body with Enter, then Escape selects the card", async () => {
    const editor = detailsEditor()
    const { container, unmount } = render(<EditorContent editor={editor} />)
    const input = await screen.findByRole("textbox", { name: "折叠内容摘要" })
    fireEvent.click(screen.getByRole("button", { name: "收起折叠内容" }))

    fireEvent.keyDown(input, { key: "Enter" })
    const content = container.querySelector<HTMLElement>(
      ".article-details-content"
    )
    expect(content?.hidden).toBe(false)
    expect(editor.state.selection instanceof NodeSelection).toBe(false)

    const paragraph = content?.querySelector("p")
    expect(paragraph).not.toBeNull()
    fireEvent.keyDown(paragraph as HTMLParagraphElement, { key: "Escape" })
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect((editor.state.selection as NodeSelection).node.type.name).toBe(
      "details"
    )

    unmount()
    editor.destroy()
  })

  it("duplicates nested structure with fresh IDs in one undo step", async () => {
    const editor = detailsEditor()
    const { unmount } = render(<EditorContent editor={editor} />)

    fireEvent.click(
      await screen.findByRole("button", { name: "复制折叠内容" })
    )
    await waitFor(() => expect(editor.getJSON().content).toHaveLength(2))
    const [original, duplicate] = (editor.getJSON() as JSONContent).content ?? []
    expect(duplicate.attrs?.node_id).toMatch(/^blk_/)
    expect(duplicate.attrs?.node_id).not.toBe(original.attrs?.node_id)
    expect(duplicate.content?.[0].content?.[0].attrs?.node_id).not.toBe(
      original.content?.[0].content?.[0].attrs?.node_id
    )
    expect(duplicate.content?.[0].content?.[1].attrs?.node_id).not.toBe(
      original.content?.[0].content?.[1].attrs?.node_id
    )
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON().content).toHaveLength(1)

    unmount()
    editor.destroy()
  })

  it("moves with stable IDs and supports delete plus undo", async () => {
    const editor = detailsEditor(true, true)
    const { unmount } = render(<EditorContent editor={editor} />)

    fireEvent.click(
      await screen.findByRole("button", { name: "上移折叠内容" })
    )
    expect(editor.getJSON().content?.map((item) => item.attrs?.node_id)).toEqual(
      ["details-1", "before-1"]
    )
    expect(
      (editor.getJSON() as JSONContent).content?.[0].content?.[0].content?.[0]
        .attrs?.node_id
    ).toBe("details-p-1")

    fireEvent.click(screen.getByRole("button", { name: "删除折叠内容" }))
    expect(editor.getJSON().content?.map((item) => item.attrs?.node_id)).toEqual([
      "before-1",
    ])
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON().content?.[0].attrs?.node_id).toBe("details-1")

    unmount()
    editor.destroy()
  })

  it("keeps native details semantics and removes editor controls when read-only", async () => {
    const editor = detailsEditor(false)
    const { container, unmount } = render(<EditorContent editor={editor} />)

    const details = await waitFor(() => {
      const element = container.querySelector("details.article-details-readonly")
      expect(element).not.toBeNull()
      return element as HTMLDetailsElement
    })
    expect(details.open).toBe(true)
    expect(details.querySelector("summary")?.textContent).toBe(
      "Common question"
    )
    expect(details.textContent).toContain("First paragraph")
    expect(
      screen.queryByRole("toolbar", { name: "折叠内容工具栏" })
    ).toBeNull()

    unmount()
    editor.destroy()
  })

  it("inserts the canonical FAQ structure through the shared command", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: { type: "doc", content: [{ type: "paragraph" }] },
    })
    const command = articleEditorCommands.find(({ id }) => id === "details")

    expect(command?.run(editor)).toBe(true)
    expect(editor.getJSON().content?.find(({ type }) => type === "details")).toMatchObject({
      type: "details",
      attrs: {
        node_id: expect.stringMatching(/^blk_/),
        summary: "问题",
        open_by_default: false,
      },
      content: [
        {
          type: "detailsContent",
          content: [
            {
              type: "paragraph",
              attrs: { node_id: expect.stringMatching(/^blk_/) },
            },
          ],
        },
      ],
    })
    editor.destroy()
  })
})

describe("article details summary contract", () => {
  it("requires trimmed single-line text within the fixed limit", () => {
    expect(validateArticleDetailsSummary("  Question  ")).toEqual({
      value: "Question",
      valid: true,
      error: null,
    })
    expect(validateArticleDetailsSummary("   ").valid).toBe(false)
    expect(validateArticleDetailsSummary("Line\nbreak").valid).toBe(false)
    expect(
      validateArticleDetailsSummary(
        "x".repeat(ARTICLE_DETAILS_SUMMARY_MAX_LENGTH + 1)
      ).valid
    ).toBe(false)
    expect(normalizeArticleDetailsSummary("   ", "Fallback")).toBe("Fallback")
  })
})
