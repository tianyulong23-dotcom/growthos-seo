import { Editor, type JSONContent } from "@tiptap/core"
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
  ARTICLE_CALLOUT_ICONS,
  ARTICLE_CALLOUT_TONES,
  normalizeArticleCalloutIcon,
  normalizeArticleCalloutTone,
} from "@/features/content/article-callout"
import { articleEditorCommands } from "@/features/content/article-editor-commands"
import { articleEditorExtensions } from "@/features/content/article-editor-extensions"

function calloutEditor(editable = true, withSibling = false) {
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
          type: "callout",
          attrs: {
            node_id: "callout-1",
            tone: "warning",
            icon: "triangle-alert",
          },
          content: [
            {
              type: "paragraph",
              attrs: { node_id: "callout-p-1" },
              content: [{ type: "text", text: "First paragraph" }],
            },
            {
              type: "bulletList",
              attrs: { node_id: "callout-list-1" },
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      attrs: { node_id: "callout-p-2" },
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
  })
}

afterEach(cleanup)

describe("article callout node view", () => {
  it("renders structured paragraphs and lists with controlled semantics", async () => {
    const editor = calloutEditor()
    const { container, unmount } = render(<EditorContent editor={editor} />)

    await screen.findByRole("toolbar", { name: "提示框工具栏" })
    const callout = container.querySelector(".article-callout")
    expect(callout?.getAttribute("data-tone")).toBe("warning")
    expect(callout?.getAttribute("data-icon")).toBe("triangle-alert")
    expect(callout?.querySelectorAll("p")).toHaveLength(2)
    expect(callout?.querySelector("ul")?.textContent).toContain("List item")
    expect(editor.getJSON().content?.[0].attrs).toMatchObject({
      node_id: "callout-1",
      tone: "warning",
      icon: "triangle-alert",
    })

    unmount()
    editor.destroy()
  })

  it("changes tone and icon through controlled node controls", async () => {
    const editor = calloutEditor()
    const { unmount } = render(<EditorContent editor={editor} />)

    fireEvent.click(await screen.findByRole("button", { name: "设为提示" }))
    fireEvent.click(screen.getByRole("combobox", { name: "提示框图标" }))
    const lightbulb = await screen.findByRole("option", { name: "灯泡" })
    fireEvent.pointerDown(lightbulb)
    fireEvent.pointerUp(lightbulb)
    fireEvent.click(lightbulb)

    await waitFor(() =>
      expect(editor.getJSON().content?.[0].attrs).toMatchObject({
        node_id: "callout-1",
        tone: "tip",
        icon: "lightbulb",
      })
    )

    unmount()
    editor.destroy()
  })

  it("duplicates the full structure with fresh block IDs in one undo step", async () => {
    const editor = calloutEditor()
    const { unmount } = render(<EditorContent editor={editor} />)

    fireEvent.click(await screen.findByRole("button", { name: "复制提示框" }))

    await waitFor(() => expect(editor.getJSON().content).toHaveLength(2))
    const [original, duplicate] = (editor.getJSON() as JSONContent).content ?? []
    expect(duplicate.type).toBe("callout")
    expect(duplicate.attrs?.node_id).toMatch(/^blk_/)
    expect(duplicate.attrs?.node_id).not.toBe(original.attrs?.node_id)
    expect(duplicate.content?.[0].attrs?.node_id).not.toBe(
      original.content?.[0].attrs?.node_id
    )
    expect(duplicate.content?.[1].attrs?.node_id).not.toBe(
      original.content?.[1].attrs?.node_id
    )
    expect(
      duplicate.content?.[1].content?.[0].content?.[0].attrs?.node_id
    ).not.toBe(original.content?.[1].content?.[0].content?.[0].attrs?.node_id)

    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON().content).toHaveLength(1)

    unmount()
    editor.destroy()
  })

  it("moves with stable IDs and supports delete plus undo", async () => {
    const editor = calloutEditor(true, true)
    const { unmount } = render(<EditorContent editor={editor} />)

    fireEvent.click(await screen.findByRole("button", { name: "上移提示框" }))
    expect(
      editor.getJSON().content?.map((node) => node.attrs?.node_id)
    ).toEqual(["callout-1", "before-1"])
    expect(
      (editor.getJSON() as JSONContent).content?.[0].content?.[0].attrs
        ?.node_id
    ).toBe("callout-p-1")

    fireEvent.click(screen.getByRole("button", { name: "删除提示框" }))
    expect(
      editor.getJSON().content?.map((node) => node.attrs?.node_id)
    ).toEqual(["before-1"])
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON().content?.[0].attrs?.node_id).toBe("callout-1")

    unmount()
    editor.destroy()
  })

  it("keeps semantic content visible and removes editing controls when read-only", async () => {
    const editor = calloutEditor(false)
    const { container, unmount } = render(<EditorContent editor={editor} />)

    await waitFor(() =>
      expect(
        container.querySelector(".article-callout")?.textContent
      ).toContain("First paragraph")
    )
    expect(screen.queryByRole("toolbar", { name: "提示框工具栏" })).toBeNull()
    expect(
      container.querySelector('[data-icon="triangle-alert"]')
    ).not.toBeNull()

    unmount()
    editor.destroy()
  })

  it("inserts the same canonical callout through the shared command registry", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: { type: "doc", content: [{ type: "paragraph" }] },
    })
    const command = articleEditorCommands.find(({ id }) => id === "callout")

    expect(command?.run(editor)).toBe(true)
    const callout = editor
      .getJSON()
      .content?.find(({ type }) => type === "callout")
    expect(callout).toMatchObject({
      type: "callout",
      attrs: {
        node_id: expect.stringMatching(/^blk_/),
        tone: "note",
        icon: null,
      },
      content: [
        {
          type: "paragraph",
          attrs: { node_id: expect.stringMatching(/^blk_/) },
        },
      ],
    })
    editor.destroy()
  })
})

describe("article callout controls", () => {
  it("keeps tones and icons constrained and migrates known legacy values", () => {
    expect(ARTICLE_CALLOUT_TONES.map(([value]) => value)).toEqual([
      "note",
      "tip",
      "warning",
      "conclusion",
    ])
    expect(ARTICLE_CALLOUT_ICONS.map(([value]) => value)).toEqual([
      "info",
      "lightbulb",
      "triangle-alert",
      "circle-check",
    ])
    expect(normalizeArticleCalloutTone("info")).toBe("note")
    expect(normalizeArticleCalloutTone("success")).toBe("conclusion")
    expect(normalizeArticleCalloutTone("danger")).toBe("warning")
    expect(normalizeArticleCalloutTone("#ff0000")).toBe("note")
    expect(normalizeArticleCalloutIcon("warning")).toBe("triangle-alert")
    expect(normalizeArticleCalloutIcon("arbitrary-emoji")).toBeNull()
  })
})
