export const MAX_ARTICLE_LINK_LENGTH = 2_048
export const ARTICLE_LINK_REL_OPTIONS = [
  "nofollow",
  "sponsored",
  "ugc",
] as const

export type ArticleLinkValue = {
  href: string
  target?: "_blank" | null
  rel?: string | null
  title?: string | null
  link_kind?: "internal" | "external" | null
}

export function normalizeArticleLinkHref(value: string) {
  const href = value.trim()
  if (
    !href ||
    href.length > MAX_ARTICLE_LINK_LENGTH ||
    href.startsWith("//") ||
    href.includes("\\") ||
    [...href].some((character) => /\s|\p{Cc}/u.test(character))
  ) {
    return null
  }
  if (href.startsWith("/")) return href
  try {
    const parsed = new URL(href)
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return null
    }
    return href
  } catch {
    return null
  }
}

export function normalizeArticleLinkValue(
  value: ArticleLinkValue
): ArticleLinkValue | null {
  const href = normalizeArticleLinkHref(value.href)
  if (!href) return null
  const rel = new Set(
    String(value.rel || "")
      .split(/\s+/)
      .filter((token) =>
        ARTICLE_LINK_REL_OPTIONS.includes(
          token as (typeof ARTICLE_LINK_REL_OPTIONS)[number]
        )
      )
  )
  if (value.target === "_blank") {
    rel.add("noopener")
    rel.add("noreferrer")
  }
  return {
    href,
    target: value.target === "_blank" ? "_blank" : null,
    rel: rel.size ? [...rel].join(" ") : null,
    title: value.title?.trim() || null,
    link_kind: href.startsWith("/") ? "internal" : "external",
  }
}

export function suggestedArticleLinkHref(value: string) {
  const candidate = value.trim()
  if (
    !candidate ||
    candidate.startsWith("/") ||
    candidate.includes(":") ||
    candidate.includes(" ")
  ) {
    return null
  }
  return normalizeArticleLinkHref(`https://${candidate}`)
}
