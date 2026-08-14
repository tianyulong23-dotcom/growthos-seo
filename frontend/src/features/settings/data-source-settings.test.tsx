import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import {
  keywordQueryClient,
  keywordQueryKeys,
} from "@/features/keywords/keyword-query-client"
import { DataSourceSettings } from "@/features/settings/data-source-settings"

const settingsApi = vi.hoisted(() => ({
  disconnectGSC: vi.fn(),
  getGSCConnection: vi.fn(),
  getDataForSEOSettings: vi.fn(),
  listGSCSites: vi.fn(),
  selectGSCSite: vi.fn(),
  startGSCOAuth: vi.fn(),
  updateDataForSEOSettings: vi.fn(),
  testDataForSEOSettings: vi.fn(),
}))

vi.mock("@/api/settings", () => settingsApi)

const dataForSEOSettings = {
  login: "saved-login",
  configured: true,
  passwordConfigured: true,
  source: "database" as const,
  updatedAt: "2026-07-27T12:00:00Z",
}

describe("DataSourceSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    keywordQueryClient.clear()
    window.history.replaceState({}, "", "/")
    settingsApi.getDataForSEOSettings.mockResolvedValue(dataForSEOSettings)
    settingsApi.getGSCConnection.mockResolvedValue({
      oauthConfigured: true,
      oauthRedirectUri: "http://localhost:8000/api/v1/gsc/oauth/callback",
      grantConnected: false,
      propertyConnected: false,
      siteUrl: null,
      connectedAccountEmail: null,
      requiresReconnect: false,
    })
    settingsApi.listGSCSites.mockResolvedValue([])
    settingsApi.updateDataForSEOSettings.mockResolvedValue(dataForSEOSettings)
    settingsApi.testDataForSEOSettings.mockResolvedValue({
      success: true,
      message: "连接成功，账户余额 $42.50",
      balance: 42.5,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it("loads DataForSEO without rendering the stored password", async () => {
    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )

    expect(await screen.findByDisplayValue("saved-login")).toBeTruthy()

    const input = screen.getByLabelText("API Password") as HTMLInputElement
    expect(input.value).toBe("")
    expect(input.type).toBe("password")
    expect(screen.getByText("已保存")).toBeTruthy()
    expect(
      screen.getByText(
        "此账号由所有网站和项目共用，保存一次后会用于关键词和搜索结果数据流程。"
      )
    ).toBeTruthy()
    expect(screen.queryByText("Google Ads")).toBeNull()
    expect(settingsApi.getGSCConnection).toHaveBeenCalledWith("project-1")
    expect(screen.getByText("未授权")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "使用 Google 授权" })
    ).toBeTruthy()
  })

  it("does not request GSC while the project context is still empty", async () => {
    render(<DataSourceSettings projectId="" projectDomain="" />)

    await Promise.resolve()
    expect(settingsApi.getGSCConnection).not.toHaveBeenCalled()
    expect(settingsApi.getDataForSEOSettings).not.toHaveBeenCalled()
  })

  it("tests and saves unsaved DataForSEO values", async () => {
    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )
    await screen.findByDisplayValue("saved-login")

    fireEvent.change(screen.getByLabelText("API Login"), {
      target: { value: "new-login" },
    })
    fireEvent.change(screen.getByLabelText("API Password"), {
      target: { value: "new-password" },
    })

    const expected = {
      login: "new-login",
      password: "new-password",
    }

    fireEvent.click(
      screen.getByRole("button", { name: "测试 DataForSEO 连接" })
    )
    await waitFor(() => {
      expect(settingsApi.testDataForSEOSettings).toHaveBeenCalledWith(
        "project-1",
        expected
      )
    })

    fireEvent.click(
      screen.getByRole("button", { name: "保存 DataForSEO 设置" })
    )
    await waitFor(() => {
      expect(settingsApi.updateDataForSEOSettings).toHaveBeenCalledWith(
        "project-1",
        expected
      )
    })
  })

  it("shows deployment setup and the exact OAuth redirect URI", async () => {
    settingsApi.getGSCConnection.mockResolvedValue({
      oauthConfigured: false,
      oauthRedirectUri: "https://api.example/api/v1/gsc/oauth/callback",
      grantConnected: false,
      propertyConnected: false,
      siteUrl: null,
      connectedAccountEmail: null,
      requiresReconnect: false,
    })

    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )

    expect(
      await screen.findByText("管理员需要先配置 Google OAuth")
    ).toBeTruthy()
    expect(screen.getByText("OAuth 未配置")).toBeTruthy()
    expect(
      (screen.getByLabelText("OAuth 回调地址") as HTMLInputElement).value
    ).toBe("https://api.example/api/v1/gsc/oauth/callback")
    expect(
      screen.getByRole("button", { name: "打开 Google Cloud Console" })
    ).toBeTruthy()
  })

  it("does not report OAuth as unconfigured when connection loading fails", async () => {
    settingsApi.getGSCConnection.mockRejectedValue(new Error("项目不存在"))

    render(
      <DataSourceSettings projectId="missing-project" projectDomain="example.com" />
    )

    expect(
      await screen.findByText("无法读取 Search Console 连接状态")
    ).toBeTruthy()
    expect(screen.getByText("项目不存在")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "重试 Search Console 连接状态" })
    ).toBeTruthy()
    expect(screen.queryByText("管理员需要先配置 Google OAuth")).toBeNull()
  })

  it("automatically recovers when the GSC status endpoint briefly returns 502", async () => {
    settingsApi.getGSCConnection
      .mockRejectedValueOnce(new ApiError(502, "API request failed: 502"))
      .mockResolvedValueOnce({
        oauthConfigured: true,
        oauthRedirectUri: "https://api.example/api/v1/gsc/oauth/callback",
        grantConnected: false,
        propertyConnected: false,
        siteUrl: null,
        connectedAccountEmail: null,
        requiresReconnect: false,
      })

    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )

    expect(await screen.findByText("未授权")).toBeTruthy()
    expect(settingsApi.getGSCConnection).toHaveBeenCalledTimes(2)
    expect(screen.queryByText("API request failed: 502")).toBeNull()
  })

  it("shows every property with eligibility reasons and saves a matching property", async () => {
    settingsApi.getGSCConnection.mockResolvedValue({
      oauthConfigured: true,
      oauthRedirectUri: "https://api.example/api/v1/gsc/oauth/callback",
      grantConnected: true,
      propertyConnected: false,
      siteUrl: null,
      connectedAccountEmail: "owner@example.com",
      requiresReconnect: false,
    })
    settingsApi.listGSCSites.mockResolvedValue([
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
      {
        siteUrl: "https://example.com/",
        permissionLevel: "siteUnverifiedUser",
      },
      { siteUrl: "sc-domain:other.example", permissionLevel: "siteOwner" },
    ])
    settingsApi.selectGSCSite.mockResolvedValue({
      oauthConfigured: true,
      oauthRedirectUri: "https://api.example/api/v1/gsc/oauth/callback",
      grantConnected: true,
      propertyConnected: true,
      siteUrl: "sc-domain:example.com",
      connectedAccountEmail: "owner@example.com",
      requiresReconnect: false,
    })

    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )

    expect(await screen.findByText("owner@example.com")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("Search Console property"))
    expect(await screen.findByText("sc-domain:example.com")).toBeTruthy()
    expect(screen.getByText("未验证")).toBeTruthy()
    expect(screen.getByText("与项目域名不匹配")).toBeTruthy()
    fireEvent.click(screen.getByText("sc-domain:example.com"))
    fireEvent.click(screen.getByRole("button", { name: "保存 property" }))

    await waitFor(() => {
      expect(settingsApi.selectGSCSite).toHaveBeenCalledWith(
        "project-1",
        "sc-domain:example.com"
      )
    })
    expect(
      keywordQueryClient.getQueryData(
        keywordQueryKeys.connection("project-1")
      )
    ).toMatchObject({
      propertyConnected: true,
      siteUrl: "sc-domain:example.com",
      requiresReconnect: false,
    })
    expect(await screen.findByText("已连接，只读权限")).toBeTruthy()
  })

  it("explains empty property accounts and allows another account", async () => {
    settingsApi.getGSCConnection.mockResolvedValue({
      oauthConfigured: true,
      oauthRedirectUri: null,
      grantConnected: true,
      propertyConnected: false,
      siteUrl: null,
      connectedAccountEmail: "empty@example.com",
      requiresReconnect: false,
    })
    settingsApi.listGSCSites.mockResolvedValue([])

    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )

    expect(
      await screen.findByText(/这个 Google 账号下没有 Search Console property/)
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "授权其他 Google 账号" })
    ).toBeTruthy()
  })

  it("shows property loading failures separately and can retry", async () => {
    settingsApi.getGSCConnection.mockResolvedValue({
      oauthConfigured: true,
      oauthRedirectUri: null,
      grantConnected: true,
      propertyConnected: false,
      siteUrl: null,
      connectedAccountEmail: "owner@example.com",
      requiresReconnect: false,
    })
    settingsApi.listGSCSites
      .mockRejectedValueOnce(new Error("Google API 暂时不可用"))
      .mockResolvedValueOnce([])

    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )

    expect(await screen.findByText("Google API 暂时不可用")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "重试" }))
    expect(
      await screen.findByText(/这个 Google 账号下没有 Search Console property/)
    ).toBeTruthy()
    expect(settingsApi.listGSCSites).toHaveBeenCalledTimes(2)
  })

  it("switches to reconnect when authorization expires while listing properties", async () => {
    const connectedGrant = {
      oauthConfigured: true,
      oauthRedirectUri: null,
      grantConnected: true,
      propertyConnected: false,
      siteUrl: "sc-domain:example.com",
      connectedAccountEmail: "owner@example.com",
      requiresReconnect: false,
    }
    settingsApi.getGSCConnection
      .mockResolvedValueOnce(connectedGrant)
      .mockResolvedValueOnce({ ...connectedGrant, requiresReconnect: true })
    settingsApi.listGSCSites.mockRejectedValue(
      new Error("Search Console 授权已失效")
    )

    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )

    expect(await screen.findByText("Google 授权已失效")).toBeTruthy()
    expect(screen.queryByText("Search Console 授权已失效")).toBeNull()
    expect(settingsApi.getGSCConnection).toHaveBeenCalledTimes(2)
  })

  it("shows reconnect state without trying to list properties", async () => {
    settingsApi.getGSCConnection.mockResolvedValue({
      oauthConfigured: true,
      oauthRedirectUri: null,
      grantConnected: true,
      propertyConnected: false,
      siteUrl: "sc-domain:example.com",
      connectedAccountEmail: "owner@example.com",
      requiresReconnect: true,
    })

    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )

    expect(await screen.findByText("Google 授权已失效")).toBeTruthy()
    expect(screen.getByRole("button", { name: "重新授权" })).toBeTruthy()
    expect(settingsApi.listGSCSites).not.toHaveBeenCalled()
  })

  it("requires confirmation before disconnecting and reloads server state", async () => {
    const connected = {
      oauthConfigured: true,
      oauthRedirectUri: null,
      grantConnected: true,
      propertyConnected: true,
      siteUrl: "sc-domain:example.com",
      connectedAccountEmail: "owner@example.com",
      requiresReconnect: false,
    }
    settingsApi.getGSCConnection.mockResolvedValueOnce(connected)
    settingsApi.listGSCSites.mockResolvedValue([
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
    ])
    settingsApi.disconnectGSC.mockResolvedValue(undefined)

    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )

    expect(await screen.findByText("已连接，只读权限")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "断开连接" }))
    expect(await screen.findByText("断开 Google Search Console？")).toBeTruthy()
    expect(settingsApi.disconnectGSC).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "确认断开" }))

    await waitFor(() => {
      expect(settingsApi.disconnectGSC).toHaveBeenCalledWith("project-1")
      expect(settingsApi.getGSCConnection).toHaveBeenCalledTimes(2)
    })
    expect(await screen.findByText("Search Console 已断开")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "使用 Google 授权" })
    ).toBeTruthy()
  })

  it("reads and removes OAuth result while preserving the return path", async () => {
    window.history.replaceState(
      {},
      "",
      "/projects/project-1/settings/data-sources?returnTo=%2Fprojects%2Fproject-1%2Fkeywords%2Flibrary%23competitor-gap&gsc_oauth=cancelled"
    )

    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )

    expect(
      await screen.findByText("你取消了 Google 授权，尚未连接")
    ).toBeTruthy()
    expect(window.location.search).toContain("returnTo=")
    expect(window.location.search).not.toContain("gsc_oauth")
  })

  it("returns to the competitor gap after a property is connected", async () => {
    const returnTo = "/projects/project-1/keywords/competitor-gap"
    window.history.replaceState(
      {},
      "",
      `/projects/project-1/settings/data-sources?returnTo=${encodeURIComponent(returnTo)}`
    )
    settingsApi.getGSCConnection.mockResolvedValue({
      oauthConfigured: true,
      oauthRedirectUri: null,
      grantConnected: true,
      propertyConnected: true,
      siteUrl: "sc-domain:example.com",
      connectedAccountEmail: "owner@example.com",
      requiresReconnect: false,
    })
    settingsApi.listGSCSites.mockResolvedValue([
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
    ])

    render(
      <DataSourceSettings projectId="project-1" projectDomain="example.com" />
    )

    const returnButton = await screen.findByRole("button", {
      name: "返回竞品差距",
    })
    expect(returnButton.getAttribute("href")).toBe(returnTo)
  })
})
