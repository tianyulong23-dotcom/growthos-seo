import { apiRequest } from "@/api/client"

export type AIProviderSettings = {
  baseUrl: string
  model: string
  requestTimeoutSeconds: number
  maxRetries: number
  configured: boolean
  apiKeyConfigured: boolean
  source: "database" | "environment" | "none"
  updatedAt: string | null
}

export type AIProviderSettingsInput = {
  baseUrl: string
  model: string
  requestTimeoutSeconds: number
  maxRetries: number
  apiKey?: string
}

type AIProviderSettingsResponse = {
  base_url: string
  model: string
  request_timeout_seconds: number
  max_retries: number
  configured: boolean
  api_key_configured: boolean
  source: AIProviderSettings["source"]
  updated_at: string | null
}

type TestAIProviderSettingsResponse = {
  success: boolean
  model: string
  message: string
}

function mapSettings(settings: AIProviderSettingsResponse): AIProviderSettings {
  return {
    baseUrl: settings.base_url,
    model: settings.model,
    requestTimeoutSeconds: settings.request_timeout_seconds,
    maxRetries: settings.max_retries,
    configured: settings.configured,
    apiKeyConfigured: settings.api_key_configured,
    source: settings.source,
    updatedAt: settings.updated_at,
  }
}

function settingsBody(input: AIProviderSettingsInput) {
  return {
    base_url: input.baseUrl,
    model: input.model,
    request_timeout_seconds: input.requestTimeoutSeconds,
    max_retries: input.maxRetries,
    ...(input.apiKey ? { api_key: input.apiKey } : {}),
  }
}

export async function getAIProviderSettings(
  projectId: string
): Promise<AIProviderSettings> {
  return mapSettings(
    await apiRequest<AIProviderSettingsResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/ai-settings`
    )
  )
}

export async function updateAIProviderSettings(
  projectId: string,
  input: AIProviderSettingsInput
): Promise<AIProviderSettings> {
  return mapSettings(
    await apiRequest<AIProviderSettingsResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/ai-settings`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settingsBody(input)),
      }
    )
  )
}

export async function testAIProviderSettings(
  projectId: string,
  input: AIProviderSettingsInput
): Promise<TestAIProviderSettingsResponse> {
  return apiRequest<TestAIProviderSettingsResponse>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/ai-settings/test`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settingsBody(input)),
    }
  )
}
