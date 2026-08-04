export type SpreadsheetExportColumn = Readonly<{
  key: string;
  label: string;
}>;

export type SpreadsheetExportRow = Readonly<Record<string, unknown>>;

const sensitiveColumnPattern =
  /(?:authorization|cookie|credential|email[_-]?body|prompt|provider[_-]?(?:payload|price|token)|raw[_-]?email|secret|token)/iu;
const formulaPattern = /^\s*[=+\-@]/u;

export function assertSafeExportColumns(
  columns: readonly SpreadsheetExportColumn[],
): void {
  if (columns.length === 0) {
    throw new TypeError("Export requires at least one column.");
  }
  const keys = new Set<string>();
  for (const column of columns) {
    if (
      column.key.trim().length === 0
      || column.label.trim().length === 0
      || keys.has(column.key)
    ) {
      throw new TypeError("Export columns require unique non-blank keys.");
    }
    if (sensitiveColumnPattern.test(column.key)) {
      throw new TypeError(`Export column ${column.key} is sensitive.`);
    }
    keys.add(column.key);
  }
}

export function spreadsheetCellText(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) {
    text = "";
  } else if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError("Export dates must be valid.");
    }
    text = value.toISOString();
  } else if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || typeof value === "bigint"
  ) {
    text = String(value);
  } else {
    throw new TypeError("Export cells must be scalar values.");
  }
  return formulaPattern.test(text) ? `'${text}` : text;
}

export async function* exportRows(
  rows:
    | Iterable<SpreadsheetExportRow>
    | AsyncIterable<SpreadsheetExportRow>,
): AsyncIterable<SpreadsheetExportRow> {
  if (Symbol.asyncIterator in rows) {
    for await (const row of rows) {
      yield row;
    }
    return;
  }
  for (const row of rows) {
    yield row;
  }
}
