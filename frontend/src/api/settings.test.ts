import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  getAIProviderSettings,
  updateAIProviderSettings,
  type AIProviderSettingsInput,
} from "@/api/settings"

const client = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}))

vi.mock("@/api/client", () => client)

describe("AI provider settings API", () => {
  const input: AIProviderSettingsInput = {
    provider: "openai",
    apiProtocol: "responses",
    baseUrl: "https://models.example/v1",
    model: "default-model",
    businessModel: "business-model",
    keywordModel: "keyword-model",
    contentModel: "content-model",
    agentModel: "agent-model",
    reasoningEffort: "medium",
    businessReasoningEffort: "high",
    keywordReasoningEffort: "low",
    contentReasoningEffort: null,
    agentReasoningEffort: "high",
    requestTimeoutSeconds: 90,
    maxRetries: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("defaults legacy responses to medium reasoning with task inheritance", async () => {
    client.apiRequest.mockResolvedValue({
      provider: "openai",
      base_url: "https://models.example/v1",
      model: "gpt-5.4-mini",
      request_timeout_seconds: 90,
      max_retries: 1,
      configured: true,
      api_key_configured: true,
      source: "database",
      updated_at: null,
    })

    const settings = await getAIProviderSettings("project-1")

    expect(settings.reasoningEffort).toBe("medium")
    expect(settings.apiProtocol).toBe("chat_completions")
    expect(settings.businessReasoningEffort).toBeNull()
    expect(settings.keywordReasoningEffort).toBeNull()
    expect(settings.contentReasoningEffort).toBeNull()
    expect(settings.agentReasoningEffort).toBeNull()
  })

  it("rejects a legacy update response instead of pretending task settings were saved", async () => {
    client.apiRequest.mockResolvedValue({
      provider: "openai",
      api_protocol: "responses",
      base_url: "https://models.example/v1",
      model: "default-model",
      request_timeout_seconds: 90,
      max_retries: 1,
      configured: true,
      api_key_configured: true,
      source: "database",
      updated_at: null,
    })

    await expect(
      updateAIProviderSettings("project-1", input)
    ).rejects.toThrow("当前 API 服务仍是旧版本")
  })

  it("uses explicit null task settings returned by the current API", async () => {
    client.apiRequest.mockResolvedValue({
      provider: "openai",
      api_protocol: "responses",
      base_url: "https://models.example/v1",
      model: "default-model",
      business_model: null,
      keyword_model: "keyword-model",
      content_model: null,
      agent_model: "agent-model",
      reasoning_effort: "medium",
      business_reasoning_effort: null,
      keyword_reasoning_effort: "low",
      content_reasoning_effort: null,
      agent_reasoning_effort: "high",
      request_timeout_seconds: 90,
      max_retries: 1,
      configured: true,
      api_key_configured: true,
      source: "database",
      updated_at: null,
    })

    const saved = await updateAIProviderSettings("project-1", input)

    expect(saved.businessModel).toBeNull()
    expect(saved.apiProtocol).toBe("responses")
    expect(saved.keywordModel).toBe("keyword-model")
    expect(saved.businessReasoningEffort).toBeNull()
  })
})
