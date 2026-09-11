const explicitTermSeparator = /[,，;；\r\n]+/u

function comparisonKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

export function normalizeRecommendationTermList(
  values: readonly string[]
): string[] {
  const terms: string[] = []
  const seen = new Set<string>()

  for (const value of values) {
    for (const part of value.split(explicitTermSeparator)) {
      const term = part.trim()
      const key = comparisonKey(term)
      if (!key || seen.has(key)) continue
      seen.add(key)
      terms.push(term)
    }
  }

  return terms
}

export function recommendationMatchTerms(
  values: readonly string[],
  sourceValues: readonly string[]
): string[] {
  const sourceGroups = sourceValues
    .map((sourceValue) => ({
      key: comparisonKey(sourceValue),
      terms: normalizeRecommendationTermList([sourceValue]),
    }))
    .filter((group) => group.terms.length > 1)

  return normalizeRecommendationTermList(
    values.flatMap((value) => {
      const directTerms = normalizeRecommendationTermList([value])
      if (directTerms.length !== 1) return directTerms

      const sourceGroup = sourceGroups.find(
        (group) => group.key === comparisonKey(value)
      )
      return sourceGroup?.terms ?? directTerms
    })
  )
}
