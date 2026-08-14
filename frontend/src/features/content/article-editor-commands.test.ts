import { describe, expect, it } from "vitest"

import type { ArticleDocumentCapabilities } from "@/api/articles"
import {
  availableArticleEditorCommands,
  searchArticleEditorCommands,
} from "@/features/content/article-editor-commands"

const capabilities: ArticleDocumentCapabilities = {
  schema_version: 2,
  writable: true,
  recovery_scope: "scope",
  nodes: ["paragraph", "heading", "image", "table", "bookmark"],
  marks: [],
  heading_levels: [2, 3, 4, 5, 6],
  asset_types: ["image"],
  media_upload_enabled: false,
  can_manage_seo_advanced: false,
  limits: {},
}

describe("article command registry", () => {
  it("filters by schema capability, phase, and upload gate", () => {
    expect(
      availableArticleEditorCommands(capabilities, "P2").map(({ id }) => id)
    ).toEqual([
      "paragraph",
      "heading2",
      "heading3",
      "heading4",
      "heading5",
      "heading6",
      "table",
    ])
    expect(
      availableArticleEditorCommands(
        { ...capabilities, media_upload_enabled: true },
        "P3"
      ).map(({ id }) => id)
    ).toContain("bookmark")
  })

  it("finds commands by Chinese labels and English aliases", () => {
    const commands = availableArticleEditorCommands(capabilities, "P2")
    expect(searchArticleEditorCommands(commands, "标题")).toHaveLength(5)
    expect(searchArticleEditorCommands(commands, "excel")[0]?.id).toBe("table")
  })
})
