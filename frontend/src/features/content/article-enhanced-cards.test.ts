import { describe, expect, it } from "vitest"

import {
  articleEmbedUrl,
  articleEnhancedErrorLabel,
  articleEnhancedFallbackContent,
  articlePublicHostname,
  bookmarkAttributesFromResult,
  embedAttributesFromResult,
  normalizeArticleButtonAttributes,
} from "@/features/content/article-enhanced-cards"

describe("article enhanced card contracts", () => {
  it("normalizes complete bookmark metadata and rejects fallback results", () => {
    expect(
      bookmarkAttributesFromResult({
        kind: "bookmark",
        source_url: "https://example.com/source",
        final_url: "https://example.com/final",
        title: " Source title ",
        description: " Source description ",
        publisher: " Example Research ",
        icon_url: "https://example.com/icon.png",
        image_url: "https://example.com/cover.jpg",
        fetched_at: "2026-08-09T12:00:00Z",
        error_code: null,
        retryable: false,
      })
    ).toEqual({
      url: "https://example.com/final",
      title: "Source title",
      description: "Source description",
      publisher: "Example Research",
      icon_url: "https://example.com/icon.png",
      image_url: "https://example.com/cover.jpg",
      fetched_at: "2026-08-09T12:00:00Z",
    })
    expect(
      bookmarkAttributesFromResult({
        kind: "link",
        source_url: "https://example.com/source",
        final_url: "https://example.com/source",
        title: null,
        description: null,
        publisher: null,
        icon_url: null,
        image_url: null,
        fetched_at: null,
        error_code: "asset_import_timeout",
        retryable: true,
      })
    ).toBeNull()
  })

  it("applies the governed link contract to CTA buttons", () => {
    expect(
      normalizeArticleButtonAttributes({
        label: " Read the report ",
        href: "https://example.com/report",
        style: "secondary",
        target: "_blank",
        rel: "nofollow sponsored invalid",
      })
    ).toEqual({
      label: "Read the report",
      href: "https://example.com/report",
      style: "secondary",
      target: "_blank",
      rel: "nofollow sponsored noopener noreferrer",
    })
    expect(
      normalizeArticleButtonAttributes({
        label: "Unsafe",
        href: "javascript:alert(1)",
      })
    ).toBeNull()
  })

  it("builds iframe URLs only from controlled providers and IDs", () => {
    expect(articleEmbedUrl({ provider: "youtube", embed_id: "abc_DEF-12" })).toBe(
      "https://www.youtube-nocookie.com/embed/abc_DEF-12"
    )
    expect(articleEmbedUrl({ provider: "vimeo", embed_id: "123456" })).toBe(
      "https://player.vimeo.com/video/123456"
    )
    expect(articleEmbedUrl({ provider: "spotify", embed_id: "episode/abc123" })).toBe(
      "https://open.spotify.com/embed/episode/abc123"
    )
    expect(articleEmbedUrl({ provider: "unknown", embed_id: "abc123" })).toBeNull()
    expect(
      articleEmbedUrl({ provider: "youtube", embed_id: 'abc" onload="bad' })
    ).toBeNull()
  })

  it("normalizes embed results and creates a safe ordinary-link fallback", () => {
    expect(
      embedAttributesFromResult(
        {
          kind: "embed",
          source_url: "https://youtu.be/abc123",
          provider: "youtube",
          embed_id: "abc123",
          embed_url: "https://untrusted.example/arbitrary-iframe",
          error_code: null,
        },
        " Product demo "
      )
    ).toEqual({
      provider: "youtube",
      source_url: "https://youtu.be/abc123",
      embed_id: "abc123",
      caption: "Product demo",
    })
    expect(
      articleEnhancedFallbackContent(
        "https://example.com/source",
        "Primary source"
      )
    ).toMatchObject({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Primary source",
          marks: [
            {
              type: "link",
              attrs: {
                href: "https://example.com/source",
                target: "_blank",
                rel: "noopener noreferrer",
              },
            },
          ],
        },
      ],
    })
  })

  it("handles malformed legacy URLs and exposes stable error labels", () => {
    expect(articlePublicHostname("not a valid URL")).toBe("链接地址不可用")
    expect(articleEnhancedErrorLabel("asset_import_timeout")).toBe(
      "来源网站响应超时。"
    )
    expect(articleEnhancedErrorLabel("future_error")).toBe(
      "处理失败：future_error"
    )
  })
})
