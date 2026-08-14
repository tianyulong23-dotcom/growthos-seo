import { Editor } from "@tiptap/core"
import { EditorContent } from "@tiptap/react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ARTICLE_CODE_LANGUAGES,
  copyArticleCode,
  normalizeArticleCodeLanguage,
} from "@/features/content/article-code-block"
import { articleEditorExtensions } from "@/features/content/article-editor-extensions"

function codeEditor(language: string | null, text: string, editable = true) {
  return new Editor({
    extensions: articleEditorExtensions,
    editable,
    content: {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { node_id: "code-1", language },
          content: [{ type: "text", text }],
        },
      ],
    },
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("article code block node view", () => {
  it("renders syntax highlighting for a controlled language", async () => {
    const editor = codeEditor("javascript", "const answer = 42")
    const { container, unmount } = render(<EditorContent editor={editor} />)

    const language = await screen.findByRole("combobox", { name: "代码语言" })
    expect(language.textContent).toContain("JavaScript")
    await waitFor(() =>
      expect(container.querySelector(".hljs-keyword")?.textContent).toBe(
        "const"
      )
    )
    expect(editor.getJSON().content?.[0].attrs).toMatchObject({
      node_id: "code-1",
      language: "javascript",
    })

    unmount()
    editor.destroy()
  })

  it("falls back to plain text for an unknown language without guessing", async () => {
    const editor = codeEditor("unknown-language", "const answer = 42")
    const { container, unmount } = render(<EditorContent editor={editor} />)

    const language = await screen.findByRole("combobox", { name: "代码语言" })
    expect(language.textContent).toContain("纯文本")
    expect(
      container.querySelector('[data-language="plaintext"]')
    ).not.toBeNull()
    expect(container.querySelector('[class*="hljs-"]')).toBeNull()

    unmount()
    editor.destroy()
  })

  it("changes language without changing code or the stable node ID", () => {
    const editor = codeEditor("javascript", "const answer = 42")
    editor.commands.setNodeSelection(0)

    expect(
      editor.commands.updateAttributes("codeBlock", { language: "python" })
    ).toBe(true)
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "codeBlock",
      attrs: { node_id: "code-1", language: "python" },
      content: [{ type: "text", text: "const answer = 42" }],
    })

    editor.destroy()
  })

  it("copies only code content and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    const editor = codeEditor(
      "typescript",
      "const value: string = '<b>text</b>'"
    )
    const { unmount } = render(<EditorContent editor={editor} />)

    fireEvent.click(await screen.findByRole("button", { name: "复制代码" }))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "const value: string = '<b>text</b>'"
      )
    )
    expect(screen.getByText("代码已复制")).not.toBeNull()

    unmount()
    editor.destroy()
  })

  it("renders code as text and never executes embedded HTML", async () => {
    const code =
      '<img src=x onerror="window.__codeXss = true"><script>bad()</script>'
    const editor = codeEditor("html", code)
    const { container, unmount } = render(<EditorContent editor={editor} />)

    await screen.findByRole("combobox", { name: "代码语言" })
    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("code")?.textContent).toBe(code)
    expect(editor.getHTML()).toContain("&lt;script&gt;bad()&lt;/script&gt;")

    unmount()
    editor.destroy()
  })

  it("keeps copy available but disables language editing in read-only mode", async () => {
    const editor = codeEditor("python", "print('ok')", false)
    const { unmount } = render(<EditorContent editor={editor} />)

    const language = await screen.findByRole("combobox", { name: "代码语言" })
    const copy = screen.getByRole("button", { name: "复制代码" })
    expect(language.hasAttribute("disabled")).toBe(true)
    expect(copy.hasAttribute("disabled")).toBe(false)

    unmount()
    editor.destroy()
  })
})

describe("article code block helpers", () => {
  it("keeps the language selector constrained to supported values", () => {
    const values = ARTICLE_CODE_LANGUAGES.map(([value]) => value)
    expect(new Set(values).size).toBe(values.length)
    expect(normalizeArticleCodeLanguage("typescript")).toBe("typescript")
    expect(normalizeArticleCodeLanguage("unknown-language")).toBe("plaintext")
    expect(normalizeArticleCodeLanguage(null)).toBe("plaintext")
  })

  it("uses the clipboard fallback when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    })
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    })

    await copyArticleCode("fallback code")

    expect(execCommand).toHaveBeenCalledWith("copy")
    expect(document.querySelector("textarea")).toBeNull()
  })
})
