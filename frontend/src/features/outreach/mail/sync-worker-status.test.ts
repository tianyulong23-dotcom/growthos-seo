import { describe, expect, it } from "vitest"
import { isMailSyncWorkerRunning } from "./sync-worker-status"

const now = Date.parse("2026-09-15T02:15:00Z")
const healthy = {
  state: "POLLING", killSwitchOpen: true, lastError: null,
  lastSuccessfulSyncAt: "2026-09-15T02:14:30Z", pollingIntervalSeconds: 60,
}

describe("mail worker evidence", () => {
  it("uses fresh Gmail evidence even when Platform consumers are paused", () => {
    expect(isMailSyncWorkerRunning(healthy, false, now)).toBe(true)
  })
  it.each([
    { killSwitchOpen: false },
    { lastError: "AUTH_EXPIRED" },
    { state: "PAUSED" },
    { lastSuccessfulSyncAt: null },
    { lastSuccessfulSyncAt: "2026-09-15T02:00:00Z" },
    { lastSuccessfulSyncAt: "2026-09-15T03:00:00Z" },
  ])("does not override unhealthy Gmail evidence with Platform health", change => {
    expect(isMailSyncWorkerRunning({ ...healthy, ...change }, true, now)).toBe(false)
  })
  it("retains Platform readiness until Gmail evidence is available", () => {
    expect(isMailSyncWorkerRunning(null, true, now)).toBe(true)
    expect(isMailSyncWorkerRunning(null, false, now)).toBe(false)
  })
})
