import {
  renderPdfReportHtml,
  type PdfReportTemplateInput,
} from "./pdf-report-template.js";

export type PdfRendererPort = Readonly<{
  runtime: "ISOLATED_PDF_WORKER";
  render(input: Readonly<{ html: string }>): Promise<Uint8Array>;
}>;

export type PdfExportAdapterOptions = Readonly<{
  enabled?: boolean;
  renderer?: PdfRendererPort;
  maxHtmlBytes?: number;
}>;

export function createPdfExportAdapter(
  options: PdfExportAdapterOptions = {},
) {
  const enabled = options.enabled ?? false;
  const maxHtmlBytes = options.maxHtmlBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(maxHtmlBytes) || maxHtmlBytes < 1) {
    throw new TypeError("PDF HTML byte limit must be a positive integer.");
  }

  return {
    async export(input: Readonly<{
      filename: string;
      report: PdfReportTemplateInput;
    }>) {
      if (!enabled) {
        return {
          state: "unavailable" as const,
          code: "PDF_EXPORT_DISABLED" as const,
          message: "PDF export is disabled by configuration.",
          retryable: false as const,
        };
      }
      if (options.renderer === undefined) {
        return {
          state: "unavailable" as const,
          code: "PDF_RENDERER_UNAVAILABLE" as const,
          message: "No isolated PDF renderer is integrated.",
          retryable: false as const,
        };
      }
      if (options.renderer.runtime !== "ISOLATED_PDF_WORKER") {
        throw new TypeError("PDF export requires an isolated renderer.");
      }
      if (!input.filename.toLowerCase().endsWith(".pdf")) {
        throw new TypeError("PDF filename must end with .pdf.");
      }
      const html = renderPdfReportHtml(input.report);
      if (Buffer.byteLength(html, "utf8") > maxHtmlBytes) {
        throw new Error("PDF HTML byte limit exceeded.");
      }
      const bytes = await options.renderer.render({ html });
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
        throw new Error("PDF renderer returned an invalid document.");
      }
      return {
        state: "ready" as const,
        bytes,
        filename: input.filename,
        contentType: "application/pdf" as const,
      };
    },
  };
}
