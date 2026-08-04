import {
  assertSafeExportColumns,
  exportRows,
  spreadsheetCellText,
  type SpreadsheetExportColumn,
  type SpreadsheetExportRow,
} from "./spreadsheet-safety.js";

export type ExcelJsIsolatedWorkbook = Readonly<{
  appendRow(cells: readonly string[]): Promise<void>;
  commit(): Promise<Uint8Array>;
  abort(reason: unknown): Promise<void>;
}>;

export type ExcelJsIsolatedWriterPort = Readonly<{
  runtime: "EXCELJS_ISOLATED_WORKER";
  openWorkbook(input: Readonly<{
    sheetName: string;
    columns: readonly SpreadsheetExportColumn[];
    limits: XlsxExportLimits;
  }>): Promise<ExcelJsIsolatedWorkbook>;
}>;

export type XlsxExportLimits = Readonly<{
  maxRows: number;
  maxCellCharacters: number;
  maxEstimatedBytes: number;
}>;

export type XlsxExportInput = Readonly<{
  filename: string;
  sheetName: string;
  columns: readonly SpreadsheetExportColumn[];
  rows:
    | Iterable<SpreadsheetExportRow>
    | AsyncIterable<SpreadsheetExportRow>;
}>;

export class XlsxExportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxExportLimitError";
  }
}

const defaultLimits: XlsxExportLimits = Object.freeze({
  maxRows: 100_000,
  maxCellCharacters: 32_767,
  maxEstimatedBytes: 64 * 1024 * 1024,
});

function assertOptions(
  writer: ExcelJsIsolatedWriterPort,
  limits: XlsxExportLimits,
): void {
  if (writer.runtime !== "EXCELJS_ISOLATED_WORKER") {
    throw new TypeError("XLSX writing requires the isolated ExcelJS worker.");
  }
  if (
    !Number.isInteger(limits.maxRows)
    || limits.maxRows < 1
    || !Number.isInteger(limits.maxCellCharacters)
    || limits.maxCellCharacters < 1
    || !Number.isInteger(limits.maxEstimatedBytes)
    || limits.maxEstimatedBytes < 1
  ) {
    throw new TypeError("XLSX limits must be positive integers.");
  }
}

function assertInput(input: XlsxExportInput): void {
  assertSafeExportColumns(input.columns);
  if (!input.filename.toLowerCase().endsWith(".xlsx")) {
    throw new TypeError("XLSX filename must end with .xlsx.");
  }
  if (
    input.sheetName.trim().length === 0
    || input.sheetName.length > 31
    || /[\\/?*[\]:]/u.test(input.sheetName)
  ) {
    throw new TypeError("XLSX sheetName is invalid.");
  }
}

function rowCells(
  columns: readonly SpreadsheetExportColumn[],
  row: SpreadsheetExportRow,
  limits: XlsxExportLimits,
): readonly string[] {
  return columns.map(({ key }) => {
    const value = spreadsheetCellText(row[key]);
    if (value.length > limits.maxCellCharacters) {
      throw new XlsxExportLimitError("XLSX cell character limit exceeded.");
    }
    return value;
  });
}

function estimatedBytes(cells: readonly string[]): number {
  return cells.reduce(
    (total, cell) => total + Buffer.byteLength(cell, "utf8") + 8,
    0,
  );
}

export function createXlsxExportAdapter(options: Readonly<{
  writer: ExcelJsIsolatedWriterPort;
  limits?: XlsxExportLimits;
}>) {
  const limits = options.limits ?? defaultLimits;
  assertOptions(options.writer, limits);

  return {
    async export(input: XlsxExportInput) {
      assertInput(input);
      const workbook = await options.writer.openWorkbook({
        sheetName: input.sheetName,
        columns: input.columns,
        limits,
      });
      let rowCount = 0;
      let byteEstimate = 0;
      try {
        const headers = input.columns.map(({ label }) =>
          spreadsheetCellText(label)
        );
        byteEstimate += estimatedBytes(headers);
        if (byteEstimate > limits.maxEstimatedBytes) {
          throw new XlsxExportLimitError("XLSX byte limit exceeded.");
        }
        await workbook.appendRow(headers);
        for await (const row of exportRows(input.rows)) {
          rowCount += 1;
          if (rowCount > limits.maxRows) {
            throw new XlsxExportLimitError("XLSX row limit exceeded.");
          }
          const cells = rowCells(input.columns, row, limits);
          byteEstimate += estimatedBytes(cells);
          if (byteEstimate > limits.maxEstimatedBytes) {
            throw new XlsxExportLimitError("XLSX byte limit exceeded.");
          }
          await workbook.appendRow(cells);
        }
        const bytes = await workbook.commit();
        if (bytes.length > limits.maxEstimatedBytes) {
          throw new XlsxExportLimitError("XLSX output byte limit exceeded.");
        }
        if (
          bytes.length < 4
          || bytes[0] !== 0x50
          || bytes[1] !== 0x4b
          || bytes[2] !== 0x03
          || bytes[3] !== 0x04
        ) {
          throw new Error("XLSX writer returned an invalid ZIP container.");
        }
        return {
          bytes,
          filename: input.filename,
          contentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const,
          rowCount,
        };
      } catch (error) {
        await workbook.abort(error).catch(() => undefined);
        throw error;
      }
    },
  };
}
