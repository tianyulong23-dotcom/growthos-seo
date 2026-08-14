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
  getWordPressConnection: vi.fn(),
  saveWordPressConnection: vi.fn(),
  testWordPressConnection: vi.fn(),
  disconnectWordPressConnection: vi.fn(),
}))

vi.mock("@/api/service-connections", () => connectionApi)
vi.mock("@/features/settings/data-source-settings", () => ({
  GoogleSearchConsoleSettings: ({ projectId }: { projectId: string }) => (
    <div>Search Console OAuth · {projectId}</div>
  ),
}))

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
    connectionApi.getWordPressConnection.mockResolvedValue(connectedWordPress)
  })

  afterEach(() => cleanup())

  it("renders only API-confirmed states and keeps stored secrets empty", async () => {
    render(
      <ServiceConnectionsSettings
        projectId="project-1"
        projectDomain="example.com"
      />
    )

    expect(screen.getByText("Search Console OAuth · project-1")).toBeTruthy()
    expect(
      await screen.findByText("https://example.com · Site Editor")
    ).toBeTruthy()
    expect(screen.queryByText("Gmail")).toBeNull()
    expect(screen.getAllByText("已连接")).toHaveLength(1)
    expect(document.querySelector('[role="switch"]')).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "管理" }))

    const password = await screen.findByLabelText(/Application Password/)
    expect((password as HTMLInputElement).value).toBe("")
  })

  it("does not infer a connection when status APIs fail", async () => {
    connectionApi.getWordPressConnection.mockRejectedValue(
      new Error("WordPress 不可用")
    )

    render(<ServiceConnectionsSettings projectId="project-1" />)

    await waitFor(() => {
      expect(screen.getByText("WordPress 不可用")).toBeTruthy()
    })
    expect(screen.getAllByText("状态读取失败")).toHaveLength(1)
    expect(screen.queryByText("Gmail")).toBeNull()
    expect(screen.queryByText("已连接")).toBeNull()
  })
})
