export const ARTICLE_CALLOUT_TONES = [
  ["note", "注意"],
  ["tip", "提示"],
  ["warning", "警告"],
  ["conclusion", "结论"],
] as const

export const ARTICLE_CALLOUT_ICONS = [
  ["info", "信息"],
  ["lightbulb", "灯泡"],
  ["triangle-alert", "警示"],
  ["circle-check", "完成"],
] as const

export type ArticleCalloutTone = (typeof ARTICLE_CALLOUT_TONES)[number][0]
export type ArticleCalloutIcon = (typeof ARTICLE_CALLOUT_ICONS)[number][0]

const toneValues = new Set<string>(
  ARTICLE_CALLOUT_TONES.map(([value]) => value)
)
const iconValues = new Set<string>(
  ARTICLE_CALLOUT_ICONS.map(([value]) => value)
)

const legacyToneAliases: Record<string, ArticleCalloutTone> = {
  info: "note",
  neutral: "note",
  success: "conclusion",
  danger: "warning",
}

const legacyIconAliases: Record<string, ArticleCalloutIcon> = {
  alert: "triangle-alert",
  check: "circle-check",
  idea: "lightbulb",
  warning: "triangle-alert",
}

export function normalizeArticleCalloutTone(
  value: unknown
): ArticleCalloutTone {
  if (typeof value !== "string") return "note"
  if (toneValues.has(value)) return value as ArticleCalloutTone
  return legacyToneAliases[value] ?? "note"
}

export function normalizeArticleCalloutIcon(
  value: unknown
): ArticleCalloutIcon | null {
  if (typeof value !== "string" || !value) return null
  if (iconValues.has(value)) return value as ArticleCalloutIcon
  return legacyIconAliases[value] ?? null
}
