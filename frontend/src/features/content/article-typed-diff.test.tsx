import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { ArticleVersionDiff } from "@/api/articles"
import { ArticleTypedDiff } from "@/features/content/article-typed-diff"

const version = (number: number) => ({
  id: `version-${number}`,
  run_id: "run-1",
  version_number: number,
  version_type: "manual_edit",
  review_version: number,
  created_by: "editor",
  restored_from_version_id: null,
  restorable: true,
  created_at: "2026-08-10T00:00:00Z",
})

const diff: ArticleVersionDiff = {
  from_version: version(3),
  to_version: version(4),
  algorithm_version: "article-typed-diff.v1",
  summary: {
    blocks_added: 0,
    blocks_removed: 0,
    blocks_moved: 1,
    blocks_updated: 1,
    inline_changes: 1,
    media_changes: 2,
    table_changes: 1,
    metadata_changes: 1,
  },
  block_changes: [
    {
      change_id: "block-move",
      kind: "moved",
      node_id: "section-1",
      node_type: "heading",
      before_index: 1,
      after_index: 3,
      before: { text: "Benefits" },
      after: { text: "Benefits" },
      attribute_changes: [],
    },
    {
      change_id: "block-update",
      kind: "updated",
      node_id: "paragraph-1",
      node_type: "paragraph",
      before_index: 2,
      after_index: 2,
      before: { textAlign: null },
      after: { textAlign: "center" },
      attribute_changes: [
        { path: "attrs.textAlign", before: null, after: "center" },
      ],
    },
  ],
  inline_changes: [
    {
      change_id: "inline-link",
      node_id: "paragraph-1",
      kind: "marks_changed",
      before_text: "source",
      after_text: "source",
      before_range: [0, 6],
      after_range: [0, 6],
      before_marks: [{ type: "link", attrs: { href: "/old" } }],
      after_marks: [{ type: "link", attrs: { href: "/new" } }],
    },
  ],
  media_changes: [
    {
      change_id: "image-replace",
      node_id: "image-1",
      node_type: "image",
      kind: "asset_replaced",
      path: "attrs.asset_id",
      before: "asset-old",
      after: "asset-new",
    },
    {
      change_id: "gallery-order",
      node_id: "gallery-1",
      node_type: "gallery",
      kind: "reordered",
      path: "attrs.items",
      before: ["a", "b"],
      after: ["b", "a"],
    },
  ],
  table_changes: [
    {
      change_id: "table-cell",
      node_id: "table-1",
      row: 1,
      column: 2,
      kind: "cell_changed",
      before: { text: "10" },
      after: { text: "12" },
    },
  ],
  metadata_changes: [
    { field: "meta_description", before: "Old SEO", after: "New SEO" },
  ],
  added_lines: 1,
  removed_lines: 1,
  truncated: false,
  lines: [
    { kind: "removed", content: "Old SEO", old_line_number: 1, new_line_number: null },
    { kind: "added", content: "New SEO", old_line_number: null, new_line_number: 1 },
  ],
}

afterEach(cleanup)

describe("ArticleTypedDiff", () => {
  it("renders block, mark/link, media, table, metadata, algorithm, and line changes", () => {
    render(<ArticleTypedDiff diff={diff} />)

    expect(screen.getByText("article-typed-diff.v1")).toBeTruthy()
    expect(screen.getByText("内容块变化")).toBeTruthy()
    expect(screen.getByText("移动")).toBeTruthy()
    expect(screen.getByText("attrs.textAlign")).toBeTruthy()
    expect(screen.getByText("文字与格式变化")).toBeTruthy()
    expect(screen.getByText("/old", { exact: false })).toBeTruthy()
    expect(screen.getByText("/new", { exact: false })).toBeTruthy()
    expect(screen.getByText("资产替换")).toBeTruthy()
    expect(screen.getByText("顺序变化")).toBeTruthy()
    expect(screen.getByText("第 2 行，第 3 列")).toBeTruthy()
    expect(screen.getByText("Meta Description")).toBeTruthy()

    fireEvent.click(screen.getByText("兼容行差异（+1 / -1）"))
    expect(screen.getAllByText("Old SEO").length).toBeGreaterThan(0)
    expect(screen.getAllByText("New SEO").length).toBeGreaterThan(0)
  })
})
