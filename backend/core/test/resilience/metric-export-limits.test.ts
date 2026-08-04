import { describe, expect, it } from "vitest";

import {
  createXlsxExportAdapter,
  type ExcelJsIsolatedWorkbook,
} from "../../src/modules/backlinks/adapters/export/xlsx-export.adapter.js";

describe("BL-AI-167 XLSX export resource limits", () => {
  it("aborts the streaming workbook when the row cap is exceeded", async () => {
    let aborted = false;
    let committed = false;
    const workbook: ExcelJsIsolatedWorkbook = {
      appendRow: async () => undefined,
      commit: async () => {
        committed = true;
        return Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
      },
      abort: async () => {
        aborted = true;
      },
    };
    const adapter = createXlsxExportAdapter({
      writer: {
        runtime: "EXCELJS_ISOLATED_WORKER",
        openWorkbook: async () => workbook,
      },
      limits: {
        maxRows: 2,
        maxCellCharacters: 32_767,
        maxEstimatedBytes: 1_024,
      },
    });

    await expect(adapter.export({
      filename: "metrics.xlsx",
      sheetName: "Metrics",
      columns: [{ key: "value", label: "Value" }],
      rows: [{ value: 1 }, { value: 2 }, { value: 3 }],
    })).rejects.toThrow(/row limit/i);
    expect(aborted).toBe(true);
    expect(committed).toBe(false);
  });

  it("aborts before memory estimates cross the configured byte limit", async () => {
    let aborted = false;
    const adapter = createXlsxExportAdapter({
      writer: {
        runtime: "EXCELJS_ISOLATED_WORKER",
        openWorkbook: async () => ({
          appendRow: async () => undefined,
          commit: async () => Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
          abort: async () => {
            aborted = true;
          },
        }),
      },
      limits: {
        maxRows: 10,
        maxCellCharacters: 100,
        maxEstimatedBytes: 12,
      },
    });

    await expect(adapter.export({
      filename: "metrics.xlsx",
      sheetName: "Metrics",
      columns: [{ key: "value", label: "Value" }],
      rows: [{ value: "01234567890123456789" }],
    })).rejects.toThrow(/byte limit/i);
    expect(aborted).toBe(true);
  });

  it("rejects an isolated worker result larger than the output byte cap", async () => {
    let aborted = false;
    const adapter = createXlsxExportAdapter({
      writer: {
        runtime: "EXCELJS_ISOLATED_WORKER",
        openWorkbook: async ({ limits }) => {
          expect(limits.maxEstimatedBytes).toBe(64);
          return {
            appendRow: async () => undefined,
            commit: async () => {
              const bytes = new Uint8Array(65);
              bytes.set([0x50, 0x4b, 0x03, 0x04]);
              return bytes;
            },
            abort: async () => {
              aborted = true;
            },
          };
        },
      },
      limits: {
        maxRows: 10,
        maxCellCharacters: 100,
        maxEstimatedBytes: 64,
      },
    });

    await expect(adapter.export({
      filename: "metrics.xlsx",
      sheetName: "Metrics",
      columns: [{ key: "value", label: "Value" }],
      rows: [],
    })).rejects.toThrow(/output byte limit/i);
    expect(aborted).toBe(true);
  });
});
