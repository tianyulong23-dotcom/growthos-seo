import { afterEach, describe, expect, it, vi } from "vitest"

import {
  buildCsv,
  copyTableToClipboard,
  normalizeExportValue,
} from "@/features/keywords/gsc-performance-export"

class TestClipboardItem {
  readonly data: Record<string, Blob | Promise<Blob>>

  constructor(data: Record<string, Blob | Promise<Blob>>) {
    this.data = data
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GSC performance exports", () => {
  it("matches OpenSEO CSV normalization and line endings", () => {
    expect(normalizeExportValue(1.235)).toBe(1.24)
    expect(normalizeExportValue("\nformula")).toBe("'\nformula")

    const csv = buildCsv(
      ["Query", "Position"],
      [
        ["=SUM(A1:A2)", 6.444],
        ["safe", null],
      ]
    )

    expect(csv).toBe('"Query","Position"\n"\'=SUM(A1:A2)","6.44"\n"safe",""')
    expect(csv.startsWith("\uFEFF")).toBe(false)
    expect(csv.includes("\r\n")).toBe(false)
  })

  it("copies both TSV and linked HTML for Google Sheets", async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("ClipboardItem", TestClipboardItem)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    })

    await copyTableToClipboard(
      ["Page", "Position"],
      [["https://example.com/a?x=1&y=2", 6.444]]
    )

    const items = write.mock.calls[0]?.[0] as TestClipboardItem[]
    const item = items[0]
    const plainBlob = await item.data["text/plain"]
    const htmlBlob = await item.data["text/html"]
    expect(await plainBlob.text()).toBe(
      "Page\tPosition\nhttps://example.com/a?x=1&y=2\t6.44"
    )
    expect(await htmlBlob.text()).toContain(
      '<a href="https://example.com/a?x=1&amp;y=2">https://example.com/a?x=1&amp;y=2</a>'
    )
  })
})
