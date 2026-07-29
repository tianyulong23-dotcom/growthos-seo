export type PdfReportTemplateInput = Readonly<{
  title: string;
  generatedAt: Date;
  revision: number;
  metrics: readonly Readonly<{
    label: string;
    value: string | number | null;
    definitionVersion: string;
  }>[];
}>;

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderPdfReportHtml(input: PdfReportTemplateInput): string {
  if (!Number.isFinite(input.generatedAt.getTime())) {
    throw new TypeError("PDF report generatedAt must be valid.");
  }
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new TypeError("PDF report revision must be positive.");
  }
  const metricRows = input.metrics.map((metric) => `
      <tr>
        <th scope="row">${escapeHtml(metric.label)}</th>
        <td>${escapeHtml(metric.value ?? "")}</td>
        <td>${escapeHtml(metric.definitionVersion)}</td>
      </tr>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <title>${escapeHtml(input.title)}</title>
  <style>
    @page { size: A4; margin: 18mm; }
    body { color: #111; font: 12px Arial, sans-serif; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { color: #444; margin: 0 0 18px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #ccc; padding: 8px; text-align: left; }
    th { font-weight: 600; }
  </style>
</head>
<body>
  <h1>${escapeHtml(input.title)}</h1>
  <p>Revision ${input.revision} | ${input.generatedAt.toISOString()}</p>
  <table>
    <thead><tr><th>Metric</th><th>Value</th><th>Definition</th></tr></thead>
    <tbody>${metricRows}</tbody>
  </table>
</body>
</html>`;
}
