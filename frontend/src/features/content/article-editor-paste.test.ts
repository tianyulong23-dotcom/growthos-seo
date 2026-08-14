import { describe, expect, it } from "vitest"

import { ARTICLE_PASTE_FIXTURES } from "@/features/content/__fixtures__/article-editor-paste-fixtures"
import {
  ARTICLE_HIGHLIGHT_COLORS,
  ARTICLE_PASTE_LIST_DEPTH_LIMIT,
  ARTICLE_PASTE_TABLE_LIMITS,
  buildArticlePasteInsertion,
  reviewArticlePasteHtml,
  sanitizeArticlePasteHtml,
} from "@/features/content/article-editor-paste"

describe("article paste sanitizer", () => {
  it("keeps semantics while removing Word and script presentation data", () => {
    const result = sanitizeArticlePasteHtml(`
      <h1 class="MsoTitle" style="font-size:32pt" onclick="evil()">Title</h1>
      <p class="MsoNormal" style="color:red" onmouseover="evil()"><strong>Body</strong></p>
      <script>alert(1)</script><style>body{display:none}</style>
    `)
    expect(result).toContain("<h2>Title</h2>")
    expect(result).toContain("<p><strong>Body</strong></p>")
    expect(result).not.toMatch(/class=|onclick|onmouseover|script|style>/i)
  })

  it("normalizes highlights to the five-color whitelist", () => {
    const result = sanitizeArticlePasteHtml(
      '<mark style="background-color: rgb(255, 0, 0)">Risk</mark>'
    )
    expect(result).toContain(`data-color="${ARTICLE_HIGHLIGHT_COLORS[0]}"`)
  })

  it("keeps safe table spans and alignment while removing arbitrary CSS", () => {
    const result = sanitizeArticlePasteHtml(
      '<table class="excel"><tr><th colspan="2" style="text-align:center;color:red">Name</th></tr></table>'
    )
    expect(result).toContain('colspan="2"')
    expect(result).toContain('style="text-align:center"')
    expect(result).not.toContain("color:red")
    expect(result).not.toContain("class=")
  })

  it("rejects unsafe links and secures external blank targets", () => {
    const result = sanitizeArticlePasteHtml(
      '<a href="javascript:alert(1)">bad</a><a href="https://example.com" target="_blank" rel="ugc evil">ok</a>'
    )
    expect(result).toContain("bad")
    expect(result).not.toContain("javascript")
    expect(result).toContain('rel="ugc noopener noreferrer"')
  })

  it("recognizes Word and Google Docs fixtures while preserving basic marks", () => {
    const word = reviewArticlePasteHtml(ARTICLE_PASTE_FIXTURES.word)
    expect(word.source).toBe("word")
    expect(word.sanitizedHtml).toContain("<h2>Word title</h2>")
    expect(word.sanitizedHtml).toContain("<strong>Bold</strong>")

    const docs = reviewArticlePasteHtml(ARTICLE_PASTE_FIXTURES.googleDocs)
    expect(docs.source).toBe("google_docs")
    expect(docs.sanitizedHtml).toContain("<em>Docs heading</em>")
    expect(docs.sanitizedHtml).toContain("<ul>")
  })

  it("uses only Excel clipboard display values", () => {
    const review = reviewArticlePasteHtml(ARTICLE_PASTE_FIXTURES.excel)
    expect(review.source).toBe("excel")
    expect(review.sanitizedHtml).toContain("<td>2</td>")
    expect(review.sanitizedHtml).toContain("<td>2026-08-09</td>")
    expect(review.sanitizedHtml).not.toMatch(/fmla|SUM|TODAY/i)
  })

  it("lists remote web images for import and never leaves image URLs in HTML", () => {
    const review = reviewArticlePasteHtml(ARTICLE_PASTE_FIXTURES.web)
    expect(review.source).toBe("web")
    expect(review.remoteImages).toEqual([
      { url: "https://cdn.example.com/hero.png", alt: "Hero image" },
    ])
    expect(review.requiresConfirmation).toBe(true)
    expect(review.sanitizedHtml).toContain("Before")
    expect(review.sanitizedHtml).toContain("After")
    expect(review.sanitizedHtml).not.toMatch(/<img|cdn\.example|data:image/i)
    expect(review.segments).toEqual([
      { type: "html", html: expect.stringContaining("Before") },
      { type: "remote_image", imageIndex: 0 },
      { type: "html", html: expect.stringContaining("After") },
    ])
  })

  it("builds one stable anchor for each selected image occurrence", () => {
    const review = reviewArticlePasteHtml(
      '<p>Before<img src="https://cdn.example.com/a.png" alt="First">Middle<img src="https://cdn.example.com/a.png" alt="Second">After</p>'
    )
    let sequence = 0
    const insertion = buildArticlePasteInsertion(
      review,
      new Set([0, 1]),
      () => `paste-anchor-${++sequence}`
    )

    expect(insertion.remoteImages).toEqual([
      { imageIndex: 0, anchorNodeId: "paste-anchor-1" },
      { imageIndex: 1, anchorNodeId: "paste-anchor-2" },
    ])
    expect(insertion.html).toContain("Before")
    expect(insertion.html).toContain('data-node-id="paste-anchor-1"')
    expect(insertion.html).toContain("Middle")
    expect(insertion.html).toContain('data-node-id="paste-anchor-2"')
    expect(insertion.html).toContain("After")
    expect(insertion.html).not.toContain("cdn.example.com")
  })

  it("omits unselected remote image occurrences without collapsing indexes", () => {
    const review = reviewArticlePasteHtml(
      '<p>A<img src="https://cdn.example.com/a.png">B<img src="https://cdn.example.com/b.png">C</p>'
    )
    const insertion = buildArticlePasteInsertion(
      review,
      new Set([1]),
      () => "selected-anchor"
    )

    expect(insertion.remoteImages).toEqual([
      { imageIndex: 1, anchorNodeId: "selected-anchor" },
    ])
    expect(insertion.html.match(/data-node-id/g)).toHaveLength(1)
    expect(insertion.html).toContain("A")
    expect(insertion.html).toContain("B")
    expect(insertion.html).toContain("C")
  })

  it("removes active content from the malicious fixture", () => {
    const review = reviewArticlePasteHtml(ARTICLE_PASTE_FIXTURES.malicious)
    expect(review.sanitizedHtml).toContain("Safe text")
    expect(review.sanitizedHtml).not.toMatch(
      /script|iframe|svg|onclick|javascript/i
    )
  })

  it("flattens list content beyond the supported depth and requires confirmation", () => {
    const review = reviewArticlePasteHtml(ARTICLE_PASTE_FIXTURES.deepList)
    const parsed = new DOMParser().parseFromString(
      review.sanitizedHtml,
      "text/html"
    )
    const depths = Array.from(parsed.body.querySelectorAll("ul, ol")).map(
      (list) => {
        let depth = 1
        let parent = list.parentElement
        while (parent) {
          if (parent.matches("ul, ol")) depth += 1
          parent = parent.parentElement
        }
        return depth
      }
    )
    expect(review.listDepthExceeded).toBe(true)
    expect(review.requiresConfirmation).toBe(true)
    expect(Math.max(...depths)).toBeLessThanOrEqual(
      ARTICLE_PASTE_LIST_DEPTH_LIMIT
    )
    expect(review.sanitizedHtml).toContain("Five")
  })

  it("previews and clips oversized tables only after confirmation", () => {
    const review = reviewArticlePasteHtml(ARTICLE_PASTE_FIXTURES.oversizedTable)
    expect(review.requiresConfirmation).toBe(true)
    expect(review.tables).toEqual([
      expect.objectContaining({
        originalRows: 22,
        originalColumns: 23,
        acceptedRows: ARTICLE_PASTE_TABLE_LIMITS.rows,
        acceptedColumns: ARTICLE_PASTE_TABLE_LIMITS.columns,
        clipped: true,
        preview: [
          ["R1C1", "R1C2", "R1C3", "R1C4"],
          ["R2C1", "R2C2", "R2C3", "R2C4"],
          ["R3C1", "R3C2", "R3C3", "R3C4"],
        ],
      }),
    ])
    const parsed = new DOMParser().parseFromString(
      review.sanitizedHtml,
      "text/html"
    )
    expect(parsed.querySelectorAll("tr")).toHaveLength(20)
    expect(parsed.querySelectorAll("tr:first-child > td")).toHaveLength(20)
    expect(review.sanitizedHtml).not.toContain("R22C23")
  })
})
