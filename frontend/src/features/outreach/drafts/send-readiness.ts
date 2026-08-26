export const sendReadinessSubmissionSafetyWindowMs = 5_000

export function isSendReadinessSnapshotUsable(
  expiresAt: string,
  nowMs = Date.now()
): boolean {
  const expirationMs = Date.parse(expiresAt)
  return (
    Number.isFinite(expirationMs) &&
    expirationMs - nowMs > sendReadinessSubmissionSafetyWindowMs
  )
}
