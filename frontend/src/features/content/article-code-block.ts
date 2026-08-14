export const ARTICLE_CODE_LANGUAGES = [
  ["plaintext", "纯文本"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["html", "HTML"],
  ["css", "CSS"],
  ["json", "JSON"],
  ["bash", "Bash / Shell"],
  ["python", "Python"],
  ["sql", "SQL"],
  ["java", "Java"],
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["php", "PHP"],
  ["ruby", "Ruby"],
  ["kotlin", "Kotlin"],
  ["swift", "Swift"],
  ["markdown", "Markdown"],
  ["yaml", "YAML"],
] as const

export type ArticleCodeLanguage = (typeof ARTICLE_CODE_LANGUAGES)[number][0]

const ARTICLE_CODE_LANGUAGE_VALUES: ReadonlySet<string> = new Set(
  ARTICLE_CODE_LANGUAGES.map(([value]) => value)
)

export function normalizeArticleCodeLanguage(
  value: unknown
): ArticleCodeLanguage {
  return typeof value === "string" && ARTICLE_CODE_LANGUAGE_VALUES.has(value)
    ? (value as ArticleCodeLanguage)
    : "plaintext"
}

export async function copyArticleCode(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const field = document.createElement("textarea")
  field.value = text
  field.readOnly = true
  field.style.position = "fixed"
  field.style.opacity = "0"
  document.body.append(field)
  field.select()
  const copied = document.execCommand("copy")
  field.remove()
  if (!copied) throw new Error("clipboard_unavailable")
}
