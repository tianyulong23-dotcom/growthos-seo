import { apiRequest } from "@/api/client"

export type SettingsSource = "database" | "environment" | "none"

export type AIProviderSettings = {
  baseUrl: string
  model: string
  requestTimeoutSeconds: number
  maxRetries: number
  configured: boolean
  apiKeyConfigured: boolean
  source: SettingsSource
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
  void projectId
  return mapSettings(
    await apiRequest<AIProviderSettingsResponse>("/api/v1/platform/settings/ai")
  )
}

export async function updateAIProviderSettings(
  _projectId: string,
  input: AIProviderSettingsInput
): Promise<AIProviderSettings> {
  return mapSettings(
    await apiRequest<AIProviderSettingsResponse>(
      "/api/v1/platform/settings/ai",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settingsBody(input)),
      }
    )
  )
}

export async function testAIProviderSettings(
  _projectId: string,
  input: AIProviderSettingsInput
): Promise<TestAIProviderSettingsResponse> {
  return apiRequest<TestAIProviderSettingsResponse>(
    "/api/v1/platform/settings/ai/test",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settingsBody(input)),
    }
  )
}

export type GoogleAdsSettings = {
  clientId: string
  customerId: string
  loginCustomerId: string
  configured: boolean
  developerTokenConfigured: boolean
  clientSecretConfigured: boolean
  refreshTokenConfigured: boolean
  source: SettingsSource
  updatedAt: string | null
}

export type GoogleAdsSettingsInput = {
  clientId: string
  customerId: string
  loginCustomerId?: string
  developerToken?: string
  clientSecret?: string
  refreshToken?: string
}

type GoogleAdsSettingsResponse = {
  client_id: string
  customer_id: string
  login_customer_id: string | null
  configured: boolean
  developer_token_configured: boolean
  client_secret_configured: boolean
  refresh_token_configured: boolean
  source: SettingsSource
  updated_at: string | null
}

type TestGoogleAdsSettingsResponse = {
  success: boolean
  customer_id: string
  message: string
}

function mapGoogleAdsSettings(
  settings: GoogleAdsSettingsResponse
): GoogleAdsSettings {
  return {
    clientId: settings.client_id,
    customerId: settings.customer_id,
    loginCustomerId: settings.login_customer_id ?? "",
    configured: settings.configured,
    developerTokenConfigured: settings.developer_token_configured,
    clientSecretConfigured: settings.client_secret_configured,
    refreshTokenConfigured: settings.refresh_token_configured,
    source: settings.source,
    updatedAt: settings.updated_at,
  }
}

function googleAdsSettingsBody(input: GoogleAdsSettingsInput) {
  return {
    client_id: input.clientId,
    customer_id: input.customerId,
    login_customer_id: input.loginCustomerId || null,
    ...(input.developerToken ? { developer_token: input.developerToken } : {}),
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    ...(input.refreshToken ? { refresh_token: input.refreshToken } : {}),
  }
}

export async function getGoogleAdsSettings(
  projectId: string
): Promise<GoogleAdsSettings> {
  return mapGoogleAdsSettings(
    await apiRequest<GoogleAdsSettingsResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/google-ads-settings`
    )
  )
}

export async function updateGoogleAdsSettings(
  projectId: string,
  input: GoogleAdsSettingsInput
): Promise<GoogleAdsSettings> {
  return mapGoogleAdsSettings(
    await apiRequest<GoogleAdsSettingsResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/google-ads-settings`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(googleAdsSettingsBody(input)),
      }
    )
  )
}

export async function testGoogleAdsSettings(
  projectId: string,
  input: GoogleAdsSettingsInput
): Promise<TestGoogleAdsSettingsResponse> {
  return apiRequest<TestGoogleAdsSettingsResponse>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/google-ads-settings/test`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(googleAdsSettingsBody(input)),
    }
  )
}

export type DataForSEOSettings = {
  login: string
  configured: boolean
  passwordConfigured: boolean
  source: SettingsSource
  updatedAt: string | null
}

export type DataForSEOSettingsInput = {
  login: string
  password?: string
}

type DataForSEOSettingsResponse = {
  login: string
  configured: boolean
  password_configured: boolean
  source: SettingsSource
  updated_at: string | null
}

type TestDataForSEOSettingsResponse = {
  success: boolean
  message: string
  balance: number | null
}

function mapDataForSEOSettings(
  settings: DataForSEOSettingsResponse
): DataForSEOSettings {
  return {
    login: settings.login,
    configured: settings.configured,
    passwordConfigured: settings.password_configured,
    source: settings.source,
    updatedAt: settings.updated_at,
  }
}

function dataForSEOSettingsBody(input: DataForSEOSettingsInput) {
  return {
    login: input.login,
    ...(input.password ? { password: input.password } : {}),
  }
}

export async function getDataForSEOSettings(
  projectId: string
): Promise<DataForSEOSettings> {
  void projectId
  return mapDataForSEOSettings(
    await apiRequest<DataForSEOSettingsResponse>(
      "/api/v1/platform/settings/dataforseo"
    )
  )
}

export async function updateDataForSEOSettings(
  _projectId: string,
  input: DataForSEOSettingsInput
): Promise<DataForSEOSettings> {
  return mapDataForSEOSettings(
    await apiRequest<DataForSEOSettingsResponse>(
      "/api/v1/platform/settings/dataforseo",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dataForSEOSettingsBody(input)),
      }
    )
  )
}

export async function testDataForSEOSettings(
  _projectId: string,
  input: DataForSEOSettingsInput
): Promise<TestDataForSEOSettingsResponse> {
  return apiRequest<TestDataForSEOSettingsResponse>(
    "/api/v1/platform/settings/dataforseo/test",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dataForSEOSettingsBody(input)),
    }
  )
}
