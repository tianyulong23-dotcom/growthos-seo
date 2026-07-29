import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  createPdfExportAdapter,
} from "../../src/modules/backlinks/adapters/export/pdf-export.adapter.js";

const report = {
  title: "<script>alert(1)</script>",
  generatedAt: new Date("2026-07-29T01:00:00.000Z"),
  revision: 2,
  metrics: [{
    label: "Send count",
    value: "=3",
    definitionVersion: "send_count.v1",
  }],
};

describe("BL-AI-168 PDF export switch and template contract", () => {
  it("is disabled by default with an explainable unavailable status", async () => {
    const result = await createPdfExportAdapter().export({
      filename: "report.pdf",
      report,
    });

    expect(result).toEqual({
      state: "unavailable",
      code: "PDF_EXPORT_DISABLED",
      message: "PDF export is disabled by configuration.",
      retryable: false,
    });
  });

  it("does not silently start a browser when no renderer is integrated", async () => {
    const result = await createPdfExportAdapter({
      enabled: true,
    }).export({
      filename: "report.pdf",
      report,
    });

    expect(result).toEqual({
      state: "unavailable",
      code: "PDF_RENDERER_UNAVAILABLE",
      message: "No isolated PDF renderer is integrated.",
      retryable: false,
    });
    const source = await readFile(new URL(
      "../../src/modules/backlinks/adapters/export/pdf-export.adapter.ts",
      import.meta.url,
    ), "utf8");
    expect(source).not.toMatch(/playwright|placement-browser|browser-fallback/iu);
  });

  it("renders escaped, self-contained HTML through an injected worker port", async () => {
    let receivedHtml = "";
    const result = await createPdfExportAdapter({
      enabled: true,
      renderer: {
        runtime: "ISOLATED_PDF_WORKER",
        render: async ({ html }) => {
          receivedHtml = html;
          return new TextEncoder().encode("%PDF-1.7\n");
        },
      },
    }).export({
      filename: "report.pdf",
      report,
    });

    expect(result).toMatchObject({
      state: "ready",
      filename: "report.pdf",
      contentType: "application/pdf",
    });
    expect(receivedHtml).toContain(
      "Content-Security-Policy",
    );
    expect(receivedHtml).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(receivedHtml).not.toContain("<script>alert(1)</script>");
    expect(receivedHtml).not.toMatch(/https?:\/\//u);
  });
});
