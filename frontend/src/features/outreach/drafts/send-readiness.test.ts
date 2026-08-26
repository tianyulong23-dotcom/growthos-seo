import { describe, expect, it } from "vitest"

import {
  isSendReadinessSnapshotUsable,
  sendReadinessSubmissionSafetyWindowMs,
} from "@/features/outreach/drafts/send-readiness"

describe("send readiness snapshot", () => {
  const nowMs = Date.parse("2026-08-25T06:00:00.000Z")

  it("accepts a snapshot with enough time left to submit", () => {
    expect(
      isSendReadinessSnapshotUsable(
        new Date(
          nowMs + sendReadinessSubmissionSafetyWindowMs + 1
        ).toISOString(),
        nowMs
      )
    ).toBe(true)
  })

  it("rejects expired, nearly expired, and malformed snapshots", () => {
    expect(
      isSendReadinessSnapshotUsable(
        new Date(nowMs + sendReadinessSubmissionSafetyWindowMs).toISOString(),
        nowMs
      )
    ).toBe(false)
    expect(
      isSendReadinessSnapshotUsable(new Date(nowMs - 1).toISOString(), nowMs)
    ).toBe(false)
    expect(isSendReadinessSnapshotUsable("not-a-timestamp", nowMs)).toBe(false)
  })
})
