import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ServiceConnectionsSettings } from "@/features/settings/service-connections-settings"

const connectionApi = vi.hoisted(() => ({
  getGSCConnection: vi.fn(),
  saveGSCConnection: vi.fn(),
  testGSCConnection: vi.fn(),
  disconnectGSCConnection: vi.fn(),
  getWordPressConnection: vi.fn(),
  saveWordPressConnection: vi.fn(),
  testWordPressConnection: vi.fn(),
  disconnectWordPressConnection: vi.fn(),
}))

const gmailController = vi.hoisted(() => ({
  status: "ready" as "idle" | "loading" | "ready" | "error",
  connection: {
    connectionId: "gmail-1",
    version: 1,
    primaryEmail: "owner@example.com",
    displayName: "Owner",
    hostedDomain: null,
    grantedScopes: [],
    connectionStatus: "CONNECTED" as
      | "CONNECTING"
      | "CONNECTED"
      | "REAUTH_REQUIRED"
      | "TOKEN_REVOKED"
      | "DISCONNECTED",
    sendAvailability: "AVAILABLE" as const,
    mailSyncCapability: true,
    tokenExpiresAt: "2026-08-05T12:00:00Z",
    connectedAt: "2026-08-05T10:00:00Z",
  } as {
    connectionId: string
    version: number
    primaryEmail: string
    displayName: string | null
    hostedDomain: string | null
    grantedScopes: string[]
    connectionStatus:
      | "CONNECTING"
      | "CONNECTED"
      | "REAUTH_REQUIRED"
      | "TOKEN_REVOKED"
      | "DISCONNECTED"
    sendAvailability: "AVAILABLE" | "PAUSED"
    mailSyncCapability: boolean
    tokenExpiresAt: string
    connectedAt: string
  } | null,
  errorMessage: null as string | null,
  busyAction: null,
  lastDisconnect: null,
  refresh: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock("@/api/service-connections", () => connectionApi)
vi.mock("@/features/outreach/gmail/use-gmail-connection", () => ({
  useGmailConnection: vi.fn(() => gmailController),
}))

const connectedGSC = {
  propertyUrl: "sc-domain:example.com",
  serviceAccountEmail: "reader@example.iam.gserviceaccount.com",
  privateKeyConfigured: true,
  status: "connected" as const,
  verifiedAt: "2026-08-05T10:00:00Z",
}

const connectedWordPress = {
  siteUrl: "https://example.com",
  username: "publisher",
  applicationPasswordConfigured: true,
  verifiedUser: "Site Editor",
  status: "connected" as const,
  verifiedAt: "2026-08-05T10:00:00Z",
}

describe("ServiceConnectionsSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gmailController.status = "ready"
    gmailController.errorMessage = null
    gmailController.connection = {
      connectionId: "gmail-1",
      version: 1,
      primaryEmail: "owner@example.com",
      displayName: "Owner",
      hostedDomain: null,
      grantedScopes: [],
      connectionStatus: "CONNECTED",
      sendAvailability: "AVAILABLE",
      mailSyncCapability: true,
      tokenExpiresAt: "2026-08-05T12:00:00Z",
      connectedAt: "2026-08-05T10:00:00Z",
    }
    connectionApi.getGSCConnection.mockResolvedValue(connectedGSC)
    connectionApi.getWordPressConnection.mockResolvedValue(connectedWordPress)
  })

  afterEach(() => cleanup())

  it("renders only API-confirmed states and keeps stored secrets empty", async () => {
    render(<ServiceConnectionsSettings projectId="project-1" />)

    expect(await screen.findByText("sc-domain:example.com")).toBeTruthy()
    expect(screen.getByText("https://example.com · Site Editor")).toBeTruthy()
    expect(screen.getByText("owner@example.com")).toBeTruthy()
    expect(screen.getAllByText("已连接")).toHaveLength(3)
    expect(document.querySelector('[role="switch"]')).toBeNull()

    fireEvent.click(screen.getAllByRole("button", { name: "管理" })[0])

    const privateKey = await screen.findByLabelText(/服务账号私钥/)
    expect((privateKey as HTMLTextAreaElement).value).toBe("")
    expect(screen.queryByDisplayValue(/BEGIN PRIVATE KEY/)).toBeNull()
  })

  it("does not infer a connection when status APIs fail", async () => {
    connectionApi.getGSCConnection.mockRejectedValue(new Error("GSC 不可用"))
    connectionApi.getWordPressConnection.mockRejectedValue(
      new Error("WordPress 不可用")
    )
    gmailController.status = "error"
    gmailController.connection = null
    gmailController.errorMessage = "Gmail 不可用"

    render(<ServiceConnectionsSettings projectId="project-1" />)

    await waitFor(() => {
      expect(screen.getByText("GSC 不可用")).toBeTruthy()
      expect(screen.getByText("WordPress 不可用")).toBeTruthy()
      expect(screen.getByText("Gmail 不可用")).toBeTruthy()
    })
    expect(screen.getAllByText("状态读取失败")).toHaveLength(3)
    expect(screen.queryByText("已连接")).toBeNull()
  })
})
