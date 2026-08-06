export type GSCExportValue = string | number | boolean | null | undefined
type NormalizedExportValue = string | number | boolean

export function normalizeExportValue(
  value: GSCExportValue
): NormalizedExportValue {
  const normalized =
    typeof value === "number" ? roundExportNumber(value) : (value ?? "")
  if (
    typeof normalized === "string" &&
    normalized.length > 0 &&
    ["=", "+", "-", "@", "\t", "\r", "\n"].includes(normalized[0])
  ) {
    return `'${normalized}`
  }
  return normalized
}

export function buildCsv(headers: string[], rows: GSCExportValue[][]): string {
  return [headers, ...rows]
    .map((row) =>
      row.map((value) => csvCell(normalizeExportValue(value))).join(",")
    )
    .join("\n")
}

export function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function copyTableToClipboard(
  headers: string[],
  rows: GSCExportValue[][]
) {
  if (!navigator.clipboard?.write) {
    throw new Error("当前浏览器不支持表格剪贴板")
  }

  const safeRows = rows.map((row) =>
    row.map((value) => normalizeExportValue(value))
  )
  const tsv = buildTsv(headers, safeRows)
  const html = buildHtmlTable(headers, safeRows)

  await navigator.clipboard.write([
    new ClipboardItem({
      "text/plain": Promise.resolve(new Blob([tsv], { type: "text/plain" })),
      "text/html": Promise.resolve(new Blob([html], { type: "text/html" })),
    }),
  ])
}

function roundExportNumber(value: number): number {
  if (!Number.isFinite(value)) return value
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function csvCell(value: NormalizedExportValue): string {
  return `"${String(value).replaceAll('"', '""')}"`
}

function buildTsv(headers: string[], rows: NormalizedExportValue[][]): string {
  const lines = [headers.map(tsvCell).join("\t")]
  for (const row of rows) lines.push(row.map(tsvCell).join("\t"))
  return lines.join("\n")
}

function tsvCell(value: NormalizedExportValue): string {
  return typeof value === "string"
    ? value.replace(/[\t\r\n]+/g, " ")
    : String(value)
}

function buildHtmlTable(
  headers: string[],
  rows: NormalizedExportValue[][]
): string {
  const head = `<thead><tr>${headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join("")}</tr></thead>`
  const body = `<tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${htmlCell(cell)}</td>`).join("")}</tr>`
    )
    .join("")}</tbody>`
  return `<table>${head}${body}</table>`
}

function htmlCell(value: NormalizedExportValue): string {
  if (typeof value !== "string") return String(value)
  if (isLinkableUrl(value)) {
    const safeValue = escapeHtml(value)
    return `<a href="${safeValue}">${safeValue}</a>`
  }
  return escapeHtml(value)
}

function isLinkableUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
