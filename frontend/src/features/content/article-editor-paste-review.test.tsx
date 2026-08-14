import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  ArticleDocument,
  ArticleDocumentCapabilities,
} from "@/api/articles"
import { ARTICLE_PASTE_FIXTURES } from "@/features/content/__fixtures__/article-editor-paste-fixtures"
import { ArticleEditor } from "@/features/content/article-editor"

vi.mock("@/features/content/article-editor-operation-layer", () => ({
  ArticleEditorOperationLayer: () => null,
}))

const emptyRect = {
  x: 0,
  y: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
}

Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => emptyRect
HTMLElement.prototype.getClientRects = () => [] as unknown as DOMRectList

const emptyDocument: ArticleDocument = {
  type: "doc",
  schema_version: 2,
  content: [
    {
      type: "paragraph",
      attrs: { node_id: "blk_initial" },
      content: [{ type: "text", text: "Initial body" }],
    },
  ],
}

const capabilities: ArticleDocumentCapabilities = {
  schema_version: 2,
  writable: true,
  recovery_scope: "paste-review-test",
  nodes: ["doc", "paragraph", "heading", "text", "table"],
  marks: ["bold", "italic", "underline", "strike", "link"],
  heading_levels: [2, 3, 4, 5, 6],
  asset_types: ["image", "video", "audio", "file"],
  media_upload_enabled: false,
  can_manage_seo_advanced: false,
  limits: {},
}

function renderEditor(onChange = vi.fn()) {
  const result = render(
    <ArticleEditor
      projectId="project-paste-review"
      articleId="article-paste-review"
      document={emptyDocument}
      capabilities={capabilities}
      readOnly={false}
      onChange={onChange}
    />
  )
  return { ...result, onChange }
}

async function editableElement() {
  await screen.findByLabelText("文章正文编辑器")
  const editable = document.querySelector<HTMLElement>(".ProseMirror")
  if (!editable) throw new Error("ProseMirror editor was not mounted")
  return editable
}

function pasteHtml(editable: HTMLElement, html: string) {
  fireEvent.paste(editable, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/html" ? html : ""),
    },
  })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe("article editor paste review", () => {
  it("previews an oversized table and inserts only the confirmed 20 by 20 result", async () => {
    const { onChange } = renderEditor()
    const editable = await editableElement()

    pasteHtml(editable, ARTICLE_PASTE_FIXTURES.oversizedTable)

    expect(
      await screen.findByRole("dialog", { name: "确认粘贴内容" })
    ).toBeTruthy()
    expect(screen.getByText("表格 1 超出编辑上限")).toBeTruthy()
    expect(
      screen.getByText("原始 22 行 × 23 列，确认后保留前 20 行 × 20 列。")
    ).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "确认粘贴" }))

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "确认粘贴内容" })
      ).toBeNull()
      expect(onChange).toHaveBeenCalled()
    })
    const saved = JSON.stringify(onChange.mock.calls.at(-1)?.[0])
    expect(saved).toContain("R20C20")
    expect(saved).not.toContain("R20C21")
    expect(saved).not.toContain("R21C1")
  })

  it("cancels reviewed content without changing the document and restores editor focus", async () => {
    const { onChange } = renderEditor()
    const editable = await editableElement()

    pasteHtml(editable, ARTICLE_PASTE_FIXTURES.deepList)

    expect(
      await screen.findByText(
        "列表超过 3 层，超出的层级会转为普通段落，文字内容不会丢失。"
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "取消" }))

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "确认粘贴内容" })
      ).toBeNull()
      expect(document.activeElement).toBe(editable)
    })
    const savedDocuments = onChange.mock.calls.map(([saved]) => saved)
    expect(savedDocuments).not.toContainEqual(
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ text: "Five" }),
            ]),
          }),
        ]),
      })
    )
    expect(editable.textContent).toContain("Initial body")
    expect(editable.textContent).not.toContain("Five")
  })

  it("keeps remote web images out of the document and queue while media upload is disabled", async () => {
    const { onChange } = renderEditor()
    const editable = await editableElement()

    pasteHtml(editable, ARTICLE_PASTE_FIXTURES.web)

    expect(await screen.findByText("网页图片待导入")).toBeTruthy()
    expect(
      screen.getByText(
        "当前环境尚未开放媒体上传，本次只粘贴文字和表格，图片不会进入文章。"
      )
    ).toBeTruthy()
    const imageChoice = screen.getByRole("checkbox")
    expect(imageChoice.hasAttribute("data-disabled")).toBe(true)
    expect(imageChoice.getAttribute("data-checked")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "确认粘贴" }))

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const saved = JSON.stringify(onChange.mock.calls.at(-1)?.[0])
    expect(saved).toContain("Before")
    expect(saved).toContain("After")
    expect(saved).not.toContain("cdn.example.com")
    expect(saved).not.toContain("paste_image_anchor")
    expect(
      localStorage.getItem(
        "article-upload:project-paste-review:article-paste-review"
      ) ?? ""
    ).not.toContain("cdn.example.com")
  })
})
