export function isOutreachOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}
