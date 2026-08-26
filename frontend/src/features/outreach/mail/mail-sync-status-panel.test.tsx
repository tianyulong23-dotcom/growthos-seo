import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { GmailConnectionController } from "@/features/outreach/gmail/use-gmail-connection"

import { MailSyncStatusPanel } from "./mail-sync-status-panel"

vi.mock("@/features/outreach/gmail/gmail-account-selector", () => ({
  GmailAccountSelector: () => <div>account selector</div>,
}))

vi.mock("@/features/outreach/gmail/gmail-readiness", () => ({
  GmailReadinessBlockers: () => <div>readiness</div>,
}))

vi.mock("./mail-center", () => ({
  MailCenter: () => <div>mail center</div>,
}))

describe("MailSyncStatusPanel OAuth recovery", () => {
  it("shows the callback failure and a reachable reconnect action", () => {
    window.history.replaceState(
      {},
      "",
      "/projects/project-a/backlinks/email"
    )
    const controller = {
      status: "ready",
      connection: null,
      accounts: [
        {
          connectionId: "gmail-account",
          version: 1,
          primaryEmail: "sender@example.test",
        },
      ],
      readiness: null,
      errorMessage:
        "Google 授权服务暂时不可用，连接未完成。请点击重新连接 Gmail；系统不会误标为已连接。",
      busyAction: null,
      lastDisconnect: null,
      refresh: vi.fn(),
      connect: vi.fn(),
      select: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as GmailConnectionController

    render(<MailSyncStatusPanel controller={controller} />)

    expect(screen.getByRole("alert").textContent).toContain(
      "Google 授权服务暂时不可用"
    )
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "重新连接 Gmail",
      }).disabled
    ).toBe(false)
  })
})
