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
  provider: "openrouter" as const,
  apiProtocol: "responses" as const,
  baseUrl: "https://models.example/v1",
  model: "gpt-5.4-mini",
  businessModel: "gpt-5.6-terra",
  keywordModel: "gpt-5.4-mini",
  contentModel: "gpt-5.6-luna",
  agentModel: null,
  reasoningEffort: "medium" as const,
  businessReasoningEffort: "high" as const,
  keywordReasoningEffort: "high" as const,
  contentReasoningEffort: "low" as const,
  agentReasoningEffort: null,
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

    const modelInput = await screen.findByRole("combobox", {
      name: "默认模型",
    })
    expect((modelInput as HTMLInputElement).value).toBe("gpt-5.4-mini")
    expect(screen.getByText("OpenRouter")).toBeTruthy()
    expect(
      screen.getByRole("combobox", { name: "调用协议" }).textContent
    ).toContain("Responses API")
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
    expect(screen.getByRole("combobox", { name: "默认模型" })).toBeTruthy()
    expect(
      (screen.getByRole("combobox", { name: "业务识别模型" }) as HTMLInputElement)
        .value
    ).toBe("gpt-5.6-terra")
    expect(
      (screen.getByRole("combobox", { name: "内容模型" }) as HTMLInputElement)
        .value
    ).toBe("gpt-5.6-luna")
    expect(
      (screen.getByRole("combobox", { name: "Agent 模型" }) as HTMLInputElement)
        .value
    ).toBe("")
    expect(
      screen.getByRole("combobox", { name: "默认推理强度" }).textContent
    ).toContain("中")
    expect(
      screen.getByRole("combobox", { name: "业务识别推理强度" }).textContent
    ).toContain("高")
    expect(
      screen.getByRole("combobox", { name: "关键词推理强度" }).textContent
    ).toContain("高")
    expect(
      screen.getByText("此处保存的平台默认模型适用于所有网站和项目，无需重复配置。")
    ).toBeTruthy()
  })

  it("tests unsaved values and saves a replacement key", async () => {
    render(<AIModelSettings projectId="project-1" />)
    await screen.findByRole("combobox", { name: "默认模型" })

    fireEvent.change(screen.getByLabelText("接口地址"), {
      target: { value: "https://new.example/v1" },
    })
    fireEvent.change(screen.getByLabelText("默认模型"), {
      target: { value: "new-model" },
    })
    fireEvent.change(screen.getByLabelText("业务识别模型"), {
      target: { value: "business-model" },
    })
    fireEvent.change(screen.getByLabelText("关键词模型"), {
      target: { value: "keyword-model" },
    })
    fireEvent.change(screen.getByLabelText("内容模型"), {
      target: { value: "content-model" },
    })
    fireEvent.change(screen.getByLabelText("Agent 模型"), {
      target: { value: "agent-model" },
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
          provider: "openrouter",
          apiProtocol: "responses",
          baseUrl: "https://new.example/v1",
          model: "new-model",
          businessModel: "business-model",
          keywordModel: "keyword-model",
          contentModel: "content-model",
          agentModel: "agent-model",
          reasoningEffort: "medium",
          businessReasoningEffort: "high",
          keywordReasoningEffort: "high",
          contentReasoningEffort: "low",
          agentReasoningEffort: null,
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
          provider: "openrouter",
          apiProtocol: "responses",
          baseUrl: "https://new.example/v1",
          model: "new-model",
          businessModel: "business-model",
          keywordModel: "keyword-model",
          contentModel: "content-model",
          agentModel: "agent-model",
          reasoningEffort: "medium",
          businessReasoningEffort: "high",
          keywordReasoningEffort: "high",
          contentReasoningEffort: "low",
          agentReasoningEffort: null,
          requestTimeoutSeconds: 120,
          maxRetries: 2,
          apiKey: "new-secret",
        }
      )
    })
  })

  it("keeps the selected task model visible when the API cannot save it", async () => {
    settingsApi.updateAIProviderSettings.mockRejectedValue(
      new Error(
        "当前 API 服务仍是旧版本，任务模型和推理强度没有保存；请更新并重启后端服务"
      )
    )
    render(<AIModelSettings projectId="project-1" />)
    await screen.findByRole("combobox", { name: "默认模型" })

    const businessModelInput = screen.getByLabelText(
      "业务识别模型"
    ) as HTMLInputElement
    fireEvent.change(businessModelInput, {
      target: { value: "selected-business-model" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }))

    expect((await screen.findByRole("alert")).textContent).toContain(
      "当前 API 服务仍是旧版本"
    )
    expect(businessModelInput.value).toBe("selected-business-model")
  })
})
