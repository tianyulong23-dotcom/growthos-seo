import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  ArticleDocument,
  ArticleDocumentCapabilities,
} from "@/api/articles"
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

const document: ArticleDocument = {
  type: "doc",
  schema_version: 2,
  content: [
    {
      type: "paragraph",
      attrs: { node_id: "paragraph-1" },
      content: [{ type: "text", text: "Article body" }],
    },
  ],
}

const capabilities: ArticleDocumentCapabilities = {
  schema_version: 2,
  writable: true,
  recovery_scope: "enhanced-card-entry-test",
  nodes: ["doc", "paragraph", "text", "bookmark", "button", "embed"],
  marks: ["link"],
  heading_levels: [2, 3, 4, 5, 6],
  asset_types: [],
  media_upload_enabled: false,
  can_manage_seo_advanced: false,
  limits: {},
}

afterEach(cleanup)

describe("article editor enhanced card entry", () => {
  it.each([
    ["书签卡片", "插入书签卡片"],
    ["CTA 按钮", "插入CTA 按钮"],
    ["嵌入内容", "插入嵌入内容"],
  ] as const)(
    "opens the %s dialog from the fixed insert menu",
    async (menuItem, dialogName) => {
    render(
      <ArticleEditor
        projectId="project-1"
        articleId="article-1"
        document={document}
        capabilities={capabilities}
        readOnly={false}
        onChange={vi.fn()}
      />
    )

    await screen.findByLabelText("文章正文编辑器")
    fireEvent.click(screen.getByRole("button", { name: "插入内容" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: menuItem }))
    expect(
      await screen.findByRole("dialog", { name: dialogName })
    ).toBeTruthy()
    }
  )
})
