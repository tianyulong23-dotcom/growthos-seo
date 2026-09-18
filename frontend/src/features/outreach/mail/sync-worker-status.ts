type SyncEvidence = {
  state: string
  killSwitchOpen: boolean
  lastSuccessfulSyncAt: string | null
  lastError: string | null
  pollingIntervalSeconds: number
}

export function isMailSyncWorkerRunning(
  status: SyncEvidence | null,
  platformConsumersRunning: boolean | null,
  now = Date.now()
): boolean {
  if (status === null) return platformConsumersRunning === true
  if (!status.killSwitchOpen || status.lastError || status.state !== "POLLING") {
    return false
  }
  const lastSuccess = Date.parse(status.lastSuccessfulSyncAt ?? "")
  const age = now - lastSuccess
  return Number.isFinite(age) && age >= 0 &&
    age <= Math.max(120, status.pollingIntervalSeconds * 3) * 1000
}
