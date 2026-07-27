import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AIModelSettings } from "@/features/settings/ai-model-settings"

const settingsApi = vi.hoisted(() => ({
  getAIProviderSettings: vi.fn(),
  updateAIProviderSettings: vi.fn(),
  testAIProviderSettings: vi.fn(),
}))

vi.mock("@/api/settings", () => settingsApi)

const configuredSettings = {
  baseUrl: "https://models.example/v1",
  model: "gpt-5.4-mini",
  requestTimeoutSeconds: 90,
  maxRetries: 1,
  configured: true,
  apiKeyConfigured: true,
  source: "database" as const,
  updatedAt: "2026-07-23T10:00:00Z",
}

describe("AIModelSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsApi.getAIProviderSettings.mockResolvedValue(configuredSettings)
    settingsApi.updateAIProviderSettings.mockResolvedValue(configuredSettings)
    settingsApi.testAIProviderSettings.mockResolvedValue({
      success: true,
      model: "gpt-5.4-mini",
      message: "连接成功，模型响应格式正常",
    })
  })

  afterEach(() => {
    cleanup()
  })

  it("loads settings without rendering the stored API key", async () => {
    render(<AIModelSettings projectId="project-1" />)

    expect(await screen.findByDisplayValue("gpt-5.4-mini")).toBeTruthy()
    const keyInput = screen.getByLabelText("API 密钥") as HTMLInputElement
    expect(keyInput.value).toBe("")
    expect(keyInput.type).toBe("password")
    expect(screen.getByText("已保存")).toBeTruthy()
    const timeoutInput = screen.getByLabelText("请求超时") as HTMLInputElement
    const retriesInput = screen.getByLabelText(
      "失败重试次数"
    ) as HTMLInputElement
    expect(timeoutInput.value).toBe("90")
    expect(retriesInput.value).toBe("1")
  })

  it("tests unsaved values and saves a replacement key", async () => {
    render(<AIModelSettings projectId="project-1" />)
    await screen.findByDisplayValue("gpt-5.4-mini")

    fireEvent.change(screen.getByLabelText("接口地址"), {
      target: { value: "https://new.example/v1" },
    })
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "new-model" },
    })
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "new-secret" },
    })
    fireEvent.change(screen.getByLabelText("请求超时"), {
      target: { value: "120" },
    })
    fireEvent.change(screen.getByLabelText("失败重试次数"), {
      target: { value: "2" },
    })
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }))

    await waitFor(() => {
      expect(settingsApi.testAIProviderSettings).toHaveBeenCalledWith(
        "project-1",
        {
          baseUrl: "https://new.example/v1",
          model: "new-model",
          requestTimeoutSeconds: 120,
          maxRetries: 2,
          apiKey: "new-secret",
        }
      )
    })

    fireEvent.click(screen.getByRole("button", { name: "保存设置" }))

    await waitFor(() => {
      expect(settingsApi.updateAIProviderSettings).toHaveBeenCalledWith(
        "project-1",
        {
          baseUrl: "https://new.example/v1",
          model: "new-model",
          requestTimeoutSeconds: 120,
          maxRetries: 2,
          apiKey: "new-secret",
        }
      )
    })
  })
})
