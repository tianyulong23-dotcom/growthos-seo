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
  return mapDataForSEOSettings(
    await apiRequest<DataForSEOSettingsResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/dataforseo-settings`
    )
  )
}

export async function updateDataForSEOSettings(
  projectId: string,
  input: DataForSEOSettingsInput
): Promise<DataForSEOSettings> {
  return mapDataForSEOSettings(
    await apiRequest<DataForSEOSettingsResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/dataforseo-settings`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dataForSEOSettingsBody(input)),
      }
    )
  )
}

export async function testDataForSEOSettings(
  projectId: string,
  input: DataForSEOSettingsInput
): Promise<TestDataForSEOSettingsResponse> {
  return apiRequest<TestDataForSEOSettingsResponse>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/dataforseo-settings/test`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dataForSEOSettingsBody(input)),
    }
  )
}

export type GSCConnection = {
  oauthConfigured: boolean
  oauthRedirectUri: string | null
  grantConnected: boolean
  propertyConnected: boolean
  siteUrl: string | null
  connectedAccountEmail: string | null
  requiresReconnect: boolean
}

export type GSCSite = {
  siteUrl: string
  permissionLevel: string
}

export type GSCPerformance = {
  siteUrl: string
  startDate: string
  endDate: string
  totals: GSCPerformanceMetrics
  rows: GSCPerformanceRow[]
}

export type GSCPerformanceMetrics = {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export type GSCPerformanceRow = GSCPerformanceMetrics & {
  query: string
}

type GSCConnectionResponse = {
  oauth_configured: boolean
  oauth_redirect_uri?: string | null
  grant_connected: boolean
  property_connected: boolean
  site_url: string | null
  connected_account_email: string | null
  requires_reconnect: boolean
}

type GSCPerformanceResponse = {
  site_url: string
  start_date: string
  end_date: string
  totals: GSCPerformanceMetrics
  rows: Array<
    {
      query: string
    } & GSCPerformanceMetrics
  >
}

function mapGSCConnection(value: GSCConnectionResponse): GSCConnection {
  return {
    oauthConfigured: value.oauth_configured,
    oauthRedirectUri: value.oauth_redirect_uri ?? null,
    grantConnected: value.grant_connected,
    propertyConnected: value.property_connected,
    siteUrl: value.site_url,
    connectedAccountEmail: value.connected_account_email,
    requiresReconnect: value.requires_reconnect,
  }
}

export async function getGSCConnection(
  projectId: string
): Promise<GSCConnection> {
  return mapGSCConnection(
    await apiRequest<GSCConnectionResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/gsc/connection`
    )
  )
}

export async function getGSCPerformance(
  projectId: string,
  days = 28,
  limit = 250
): Promise<GSCPerformance> {
  const result = await apiRequest<GSCPerformanceResponse>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/gsc/performance?days=${days}&limit=${limit}`
  )
  return {
    siteUrl: result.site_url,
    startDate: result.start_date,
    endDate: result.end_date,
    totals: result.totals,
    rows: result.rows,
  }
}

export async function startGSCOAuth(
  projectId: string,
  callbackUrl: string
): Promise<string> {
  const result = await apiRequest<{ authorization_url: string }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/gsc/oauth/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_url: callbackUrl }),
    }
  )
  return result.authorization_url
}

export async function listGSCSites(projectId: string): Promise<GSCSite[]> {
  const result = await apiRequest<{
    items: Array<{ site_url: string; permission_level: string }>
  }>(`/api/v1/projects/${encodeURIComponent(projectId)}/gsc/sites`)
  return result.items.map((item) => ({
    siteUrl: item.site_url,
    permissionLevel: item.permission_level,
  }))
}

export async function selectGSCSite(
  projectId: string,
  siteUrl: string
): Promise<GSCConnection> {
  return mapGSCConnection(
    await apiRequest<GSCConnectionResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/gsc/connection`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site_url: siteUrl }),
      }
    )
  )
}

export async function disconnectGSC(projectId: string): Promise<void> {
  await apiRequest<void>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/gsc/connection`,
    { method: "DELETE" }
  )
}
