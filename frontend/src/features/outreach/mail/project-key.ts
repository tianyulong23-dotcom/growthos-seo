export function getWebsiteProjectKeyFromPathname(
  pathname: string
): string | null {
  const match = pathname.match(/\/projects\/([^/]+)/)
  if (!match?.[1]) return null

  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}
