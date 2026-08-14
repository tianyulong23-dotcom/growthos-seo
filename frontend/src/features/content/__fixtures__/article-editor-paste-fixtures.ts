function tableFixture(rows: number, columns: number) {
  return `<table><tbody>${Array.from(
    { length: rows },
    (_, row) =>
      `<tr>${Array.from(
        { length: columns },
        (_, column) => `<td>R${row + 1}C${column + 1}</td>`
      ).join("")}</tr>`
  ).join("")}</tbody></table>`
}

export const ARTICLE_PASTE_FIXTURES = {
  word: `
    <html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word">
      <body>
        <h1 class="MsoTitle" style="font-size: 32pt">Word title</h1>
        <p class="MsoNormal"><span style="font-weight:700">Bold</span> body</p>
      </body>
    </html>`,
  googleDocs: `
    <b id="docs-internal-guid-123">
      <h2><span style="font-style:italic">Docs heading</span></h2>
      <ul><li><p>Docs item</p></li></ul>
    </b>`,
  excel: `
    <html xmlns:x="urn:schemas-microsoft-com:office:excel">
      <body><table style="mso-number-format:General"><tr>
        <td x:fmla="=SUM(1,1)">2</td><td x:fmla="=TODAY()">2026-08-09</td>
      </tr></table></body>
    </html>`,
  web: `
    <article><p>Before</p>
      <img src="https://cdn.example.com/hero.png" alt="Hero image" onclick="evil()">
      <img src="data:image/png;base64,unsafe" alt="Inline image">
      <p>After</p></article>`,
  malicious: `
    <p onclick="evil()">Safe <a href="javascript:evil()">text</a></p>
    <script>alert(1)</script><iframe src="https://evil.example"></iframe>
    <svg onload="evil()"><circle /></svg>`,
  deepList: `
    <ul><li>One<ul><li>Two<ul><li>Three<ul><li>Four<ul><li>Five</li></ul></li></ul></li></ul></li></ul></li></ul>`,
  oversizedTable: tableFixture(22, 23),
} as const
