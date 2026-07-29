import { describe, expect, it } from "vitest";

import {
  createCsvExportAdapter,
} from "../../src/modules/backlinks/adapters/export/csv-export.adapter.js";
import {
  createXlsxExportAdapter,
  type ExcelJsIsolatedWorkbook,
} from "../../src/modules/backlinks/adapters/export/xlsx-export.adapter.js";

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const values: Uint8Array[] = [];
  for await (const chunk of chunks) {
    values.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(values));
}

describe("BL-AI-166/167 spreadsheet export security", () => {
  it("escapes CSV formulas and preserves UTF-8 content", async () => {
    const adapter = createCsvExportAdapter();
    const csv = await collect(adapter.export({
      columns: [
        { key: "name", label: "名称" },
        { key: "note", label: "备注" },
      ],
      rows: [{
        name: "中文站点",
        note: "=HYPERLINK(\"https://attacker.example\")",
      }, {
        name: "+cmd",
        note: "  @SUM(1,2)",
      }, {
        name: "\n=SUM(1,2)",
        note: "safe",
      }],
    }));

    expect(csv).toContain("名称,备注");
    expect(csv).toContain("中文站点");
    expect(csv).toContain(
      "\"'=HYPERLINK(\"\"https://attacker.example\"\")\"",
    );
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("\"'  @SUM(1,2)\"");
    expect(csv).toContain("\"'\n=SUM(1,2)\"");
  });

  it("rejects sensitive columns before emitting CSV data", () => {
    const adapter = createCsvExportAdapter();

    expect(() => adapter.export({
      columns: [{ key: "provider_token", label: "Token" }],
      rows: [],
    })).toThrow(/sensitive/i);
  });

  it("sanitizes XLSX cells before the isolated ExcelJS writer sees them", async () => {
    const rows: string[][] = [];
    const workbook: ExcelJsIsolatedWorkbook = {
      appendRow: async (cells) => {
        rows.push([...cells]);
      },
      commit: async () => Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
      abort: async () => undefined,
    };
    const adapter = createXlsxExportAdapter({
      writer: {
        runtime: "EXCELJS_ISOLATED_WORKER",
        openWorkbook: async () => workbook,
      },
    });

    const result = await adapter.export({
      filename: "指标.xlsx",
      sheetName: "Metrics",
      columns: [
        { key: "metric", label: "指标" },
        { key: "value", label: "值" },
      ],
      rows: [
        { metric: "@danger", value: "-1+2" },
        { metric: "\n=SUM(1)", value: "safe" },
      ],
    });

    expect(rows).toEqual([
      ["指标", "值"],
      ["'@danger", "'-1+2"],
      ["'\n=SUM(1)", "safe"],
    ]);
    expect(result).toMatchObject({
      filename: "指标.xlsx",
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      rowCount: 2,
    });
  });
});
