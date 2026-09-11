import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  GmailReadinessBlocker,
  GmailReadinessProjection,
} from "@/features/outreach/gmail/types"
import type { GmailConnectionController } from "@/features/outreach/gmail/use-gmail-connection"

import { GmailReadinessBlockers } from "./gmail-readiness"

afterEach(cleanup)

const sendContextBlocker: GmailReadinessBlocker = {
  code: "SEND_CONTEXT_REQUIRED",
  capability: "SEND",
  owner: "USER",
  retrySafe: true,
  recoveryAction: "OPEN_APPROVED_DRAFT",
  detail: "Open an approved draft and recipient.",
}

const syncCursorBlocker: GmailReadinessBlocker = {
  code: "GMAIL_SYNC_CURSOR_MISSING",
  capability: "SYNC",
  owner: "SYSTEM",
  retrySafe: true,
  recoveryAction: "REPAIR_GMAIL_SYNC_CURSOR",
  detail: "The Gmail sync cursor is missing.",
}

function controllerWith(
  blockers: GmailReadinessBlocker[]
): GmailConnectionController {
  const readiness: GmailReadinessProjection = {
    evaluatedAt: "2026-08-27T03:00:00.000Z",
    connection: { state: "CONNECTED", ready: true },
    send: {
      state: blockers.some((item) => item.capability === "SEND")
        ? "WAITING_FOR_SEND_CONTEXT"
        : "SEND_READY",
      ready: !blockers.some((item) => item.capability === "SEND"),
    },
    sync: {
      state: blockers.some((item) => item.capability === "SYNC")
        ? "BLOCKED"
        : "SYNC_READY",
      ready: !blockers.some((item) => item.capability === "SYNC"),
    },
    blockers,
    primaryBlocker: blockers[0] ?? null,
  }

  return {
    status: "ready",
    connection: null,
    accounts: [],
    readiness,
    errorMessage: null,
    busyAction: null,
    lastDisconnect: null,
    refresh: vi.fn(),
    connect: vi.fn(),
    select: vi.fn(),
    disconnect: vi.fn(),
  } as GmailConnectionController
}

describe("GmailReadinessBlockers", () => {
  it("does not report the Mail Center as broken for draft-only send context", () => {
    render(
      <GmailReadinessBlockers
        controller={controllerWith([sendContextBlocker])}
        scope="mail-center"
      />
    )

    expect(screen.queryByText("发送与同步尚未就绪")).toBeNull()
    expect(
      screen.queryByText("需要具体草稿和收件人才能完成发送预检")
    ).toBeNull()
  })

  it("keeps real Gmail sync failures visible in the Mail Center", () => {
    render(
      <GmailReadinessBlockers
        controller={controllerWith([sendContextBlocker, syncCursorBlocker])}
        scope="mail-center"
      />
    )

    expect(screen.getByText("发送与同步尚未就绪")).toBeTruthy()
    expect(screen.getByText("Gmail 同步游标缺失")).toBeTruthy()
    expect(
      screen.queryByText("需要具体草稿和收件人才能完成发送预检")
    ).toBeNull()
  })

  it("keeps draft-context blockers in full send preflight views", () => {
    render(
      <GmailReadinessBlockers
        controller={controllerWith([sendContextBlocker])}
      />
    )

    expect(
      screen.getByText("需要具体草稿和收件人才能完成发送预检")
    ).toBeTruthy()
  })
})
