const LOCAL_PRODUCT_LOOPBACK_ORIGIN = "http://127.0.0.1:5173"
const LOCAL_PRODUCT_CANONICAL_ORIGIN = "http://localhost:5173"

export const getCanonicalLocalProductUrl = (url: URL): string | null => {
  if (url.origin !== LOCAL_PRODUCT_LOOPBACK_ORIGIN) {
    return null
  }

  const canonicalUrl = new URL(url.href)
  canonicalUrl.hostname = new URL(LOCAL_PRODUCT_CANONICAL_ORIGIN).hostname
  return canonicalUrl.href
}
