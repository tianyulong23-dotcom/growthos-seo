type ContactRankItem = Readonly<{
  hostname: string
  score: number
  contactStatus: string
  contactPageUrl: string | null
  cooperationPath: Readonly<{
    decision: string
    url: string | null
  }> | null
}>

export function recommendationContactPriority(item: ContactRankItem) {
  if (item.contactStatus === "contactable") return 2
  if (
    item.contactPageUrl !== null ||
    (item.cooperationPath?.decision === "verified" &&
      item.cooperationPath.url !== null)
  ) {
    return 1
  }
  return 0
}

export function sortRecommendationsByContactAndScore<
  Item extends ContactRankItem,
>(items: readonly Item[]) {
  return [...items].sort(
    (left, right) =>
      recommendationContactPriority(right) -
        recommendationContactPriority(left) ||
      right.score - left.score ||
      left.hostname.localeCompare(right.hostname)
  )
}
