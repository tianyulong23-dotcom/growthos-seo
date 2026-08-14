import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ArticleLinkDialog } from "@/features/content/article-link-dialog"
import {
  normalizeArticleLinkHref,
  normalizeArticleLinkValue,
} from "@/features/content/article-link"

afterEach(cleanup)

describe("article link dialog contract", () => {
  it("accepts only internal paths and credential-free HTTP(S) URLs", () => {
    expect(normalizeArticleLinkHref("/guides/example/?page=2")).toBe(
      "/guides/example/?page=2"
    )
    expect(normalizeArticleLinkHref("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1"
    )
    for (const rejected of [
      "//example.com/path",
      "javascript:alert(1)",
      "data:text/html,bad",
      "file:///private",
      "https://user:secret@example.com/path",
      "https://example.com/a b",
      "/path\\escape",
    ]) {
      expect(normalizeArticleLinkHref(rejected)).toBeNull()
    }
  })

  it("adds safe rel values for a new-window external link", () => {
    expect(
      normalizeArticleLinkValue({
        href: "https://example.com/guide",
        target: "_blank",
        rel: "ugc nofollow invalid",
        title: " Guide ",
      })
    ).toEqual({
      href: "https://example.com/guide",
      target: "_blank",
      rel: "ugc nofollow noopener noreferrer",
      title: "Guide",
      link_kind: "external",
    })
  })

  it("requires explicit confirmation before completing a scheme-less URL", () => {
    const onSubmit = vi.fn()
    render(
      <ArticleLinkDialog
        open
        value={{ href: "" }}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />
    )

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "example.com/guide" },
    })
    expect(
      screen.getByText("建议补全为 https://example.com/guide")
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "保存链接" }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("HTTP/HTTPS")

    fireEvent.click(screen.getByRole("button", { name: "使用" }))
    fireEvent.click(screen.getByRole("button", { name: "保存链接" }))
    expect(onSubmit).toHaveBeenCalledWith({
      href: "https://example.com/guide",
      target: null,
      rel: null,
      title: null,
      link_kind: "external",
    })
  })

  it("submits title, relationship flags, and safe new-window behavior", () => {
    const onSubmit = vi.fn()
    render(
      <ArticleLinkDialog
        open
        value={{ href: "/old" }}
        anchorText="现有锚文本"
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />
    )

    expect(screen.getByText("现有锚文本")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://example.com/new" },
    })
    fireEvent.change(screen.getByLabelText("链接标题"), {
      target: { value: " Reference " },
    })
    fireEvent.click(screen.getByRole("checkbox", { name: "在新窗口打开" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "nofollow" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "sponsored" }))
    fireEvent.click(screen.getByRole("button", { name: "保存链接" }))

    expect(onSubmit).toHaveBeenCalledWith({
      href: "https://example.com/new",
      target: "_blank",
      rel: "nofollow sponsored noopener noreferrer",
      title: "Reference",
      link_kind: "external",
    })
  })

  it("does not reset an in-progress URL when its parent rerenders", () => {
    const props = {
      open: true,
      value: { href: "/original" },
      onOpenChange: vi.fn(),
      onSubmit: vi.fn(),
    }
    const { rerender } = render(<ArticleLinkDialog {...props} />)

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "/draft" },
    })
    rerender(<ArticleLinkDialog {...props} value={{ href: "/original" }} />)

    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe(
      "/draft"
    )
  })

  it("removes an existing link without submitting a replacement", () => {
    const onRemove = vi.fn()
    const onSubmit = vi.fn()
    render(
      <ArticleLinkDialog
        open
        value={{ href: "/existing" }}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onRemove={onRemove}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "移除链接" }))
    expect(onRemove).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
