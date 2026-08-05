import {
  assertSafeExportColumns,
  exportRows,
  spreadsheetCellText,
  type SpreadsheetExportColumn,
  type SpreadsheetExportRow,
} from "./spreadsheet-safety.js";

export type CsvExportInput = Readonly<{
  columns: readonly SpreadsheetExportColumn[];
  rows:
    | Iterable<SpreadsheetExportRow>
    | AsyncIterable<SpreadsheetExportRow>;
  includeUtf8Bom?: boolean;
}>;

function csvCell(value: unknown): string {
  const text = spreadsheetCellText(value);
  return /[",\r\n]/u.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

async function* streamCsv(input: CsvExportInput): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  if (input.includeUtf8Bom !== false) {
    yield Uint8Array.from([0xef, 0xbb, 0xbf]);
  }
  yield encoder.encode(
    `${input.columns.map(({ label }) => csvCell(label)).join(",")}\r\n`,
  );
  for await (const row of exportRows(input.rows)) {
    yield encoder.encode(
      `${input.columns.map(({ key }) => csvCell(row[key])).join(",")}\r\n`,
    );
  }
}

export function createCsvExportAdapter() {
  return {
    export(input: CsvExportInput): AsyncIterable<Uint8Array> {
      assertSafeExportColumns(input.columns);
      return streamCsv(input);
    },
  };
}
