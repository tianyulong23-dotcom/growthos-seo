import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DataSourceSettings } from "@/features/settings/data-source-settings"

const settingsApi = vi.hoisted(() => ({
  getDataForSEOSettings: vi.fn(),
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
    settingsApi.getDataForSEOSettings.mockResolvedValue(dataForSEOSettings)
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
    render(<DataSourceSettings projectId="project-1" />)

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
  })

  it("tests and saves unsaved DataForSEO values", async () => {
    render(<DataSourceSettings projectId="project-1" />)
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
})
