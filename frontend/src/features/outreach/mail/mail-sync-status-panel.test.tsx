import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { GmailConnectionController } from "@/features/outreach/gmail/use-gmail-connection"

import { MailSyncStatusPanel } from "./mail-sync-status-panel"

const mailCenterProps = vi.hoisted(() => ({
  current: null as null | {
    websiteProjectKey: string
    connectionId: string | null
    gmailSyncReady: boolean
  },
}))

vi.mock("@/features/outreach/gmail/gmail-account-selector", () => ({
  GmailAccountSelector: () => <div>account selector</div>,
}))

vi.mock("@/features/outreach/gmail/gmail-readiness", () => ({
  GmailReadinessBlockers: () => <div>readiness</div>,
}))

vi.mock("./mail-center", () => ({
  MailCenter: (props: {
    websiteProjectKey: string
    connectionId: string | null
    gmailSyncReady: boolean
  }) => {
    mailCenterProps.current = props
    return <div>mail center</div>
  },
}))

vi.mock("./draft-inbox", () => ({
  DraftInbox: ({ websiteProjectKey }: { websiteProjectKey: string }) => (
    <div>draft inbox {websiteProjectKey}</div>
  ),
}))

vi.mock("@/features/outreach/automation/automation-panel", () => ({
  AutomationPanel: ({ websiteProjectKey }: { websiteProjectKey: string }) => (
    <div>automation {websiteProjectKey}</div>
  ),
}))

describe("MailSyncStatusPanel OAuth recovery", () => {
  afterEach(() => {
    cleanup()
    mailCenterProps.current = null
  })

  it.each([false, true])("keeps connect and retry reachable on status failure (busy=%s)", (busy) => {
    window.history.replaceState({}, "", "/projects/project-a/backlinks/email")
    const controller = {
      status: "error",
      connection: null,
      accounts: [],
      readiness: null,
      errorMessage: "无法读取 Gmail 连接状态；界面不会推断为已连接。",
      busyAction: busy ? "connect" : null,
      refresh: vi.fn(),
      connect: vi.fn(),
    } as unknown as GmailConnectionController

    render(<MailSyncStatusPanel controller={controller} />)

    expect(screen.getByText("Gmail 状态未知")).toBeTruthy()
    expect(screen.queryByText("Gmail 未连接")).toBeNull()
    const connect = screen.getByRole<HTMLButtonElement>("button", {
      name: busy ? "正在连接" : "连接 Gmail",
    })
    expect(connect.disabled).toBe(busy)
    fireEvent.click(connect)
    expect(controller.connect).toHaveBeenCalledTimes(busy ? 0 : 1)
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }))
    expect(controller.refresh).toHaveBeenCalledTimes(1)
  })

  it("shows the callback failure and a reachable reconnect action", () => {
    window.history.replaceState({}, "", "/projects/project-a/backlinks/email")
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

  it("passes blocked Gmail sync readiness to the mail center", () => {
    window.history.replaceState({}, "", "/projects/project-a/backlinks/email")
    const controller = {
      status: "ready",
      connection: {
        connectionId: "gmail-account",
        version: 1,
        primaryEmail: "sender@example.test",
      },
      accounts: [],
      readiness: {
        connection: { state: "NOT_CONNECTED", ready: false },
        send: { state: "BLOCKED", ready: false },
        sync: { state: "BLOCKED", ready: false },
        blockers: [],
        primaryBlocker: null,
      },
      errorMessage: null,
      busyAction: null,
      lastDisconnect: null,
      refresh: vi.fn(),
      connect: vi.fn(),
      select: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as GmailConnectionController

    render(<MailSyncStatusPanel controller={controller} />)

    expect(
      screen.getByRole("tab", { name: "草稿" }).getAttribute("aria-selected")
    ).toBe("true")
    expect(screen.getByText("draft inbox project-a")).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "邮件往来" }))

    expect(mailCenterProps.current).toEqual({
      websiteProjectKey: "project-a",
      connectionId: "gmail-account",
      gmailSyncReady: false,
    })
    fireEvent.click(screen.getByRole("tab", { name: "自动化" }))
    expect(screen.getByText("automation project-a")).toBeTruthy()
  })
})
