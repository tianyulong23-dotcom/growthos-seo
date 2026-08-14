export const ARTICLE_DETAILS_SUMMARY_MAX_LENGTH = 300

function hasControlCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

export type ArticleDetailsSummaryValidation = {
  value: string
  valid: boolean
  error: string | null
}

export function validateArticleDetailsSummary(
  value: unknown
): ArticleDetailsSummaryValidation {
  if (typeof value !== "string") {
    return { value: "", valid: false, error: "摘要不能为空" }
  }
  const normalized = value.trim()
  if (!normalized) {
    return { value: normalized, valid: false, error: "摘要不能为空" }
  }
  if (normalized.length > ARTICLE_DETAILS_SUMMARY_MAX_LENGTH) {
    return {
      value: normalized,
      valid: false,
      error: `摘要不能超过 ${ARTICLE_DETAILS_SUMMARY_MAX_LENGTH} 个字符`,
    }
  }
  if (hasControlCharacter(normalized)) {
    return {
      value: normalized,
      valid: false,
      error: "摘要只能包含单行文本",
    }
  }
  return { value: normalized, valid: true, error: null }
}

export function normalizeArticleDetailsSummary(
  value: unknown,
  fallback = "问题"
) {
  const validation = validateArticleDetailsSummary(value)
  return validation.valid ? validation.value : fallback
}
