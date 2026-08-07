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

export type GSCPerformanceDateRange =
  "last_7_days" | "last_28_days" | "last_3_months"
export type GSCPerformanceDevice = "DESKTOP" | "MOBILE" | "TABLET"
export type GSCPerformanceDimension = "query" | "page"
export type GSCPerformancePageSize = 25 | 50 | 100

export type GSCPerformanceFilters = {
  dateRange: GSCPerformanceDateRange
  device?: GSCPerformanceDevice
  country?: string
}

export type GSCPerformanceReport = {
  siteUrl: string
  range: {
    startDate: string
    endDate: string
    previousStartDate: string
    previousEndDate: string
  }
  totals: GSCPerformanceMetrics
  previousTotals: GSCPerformanceMetrics
  strikingDistance: GSCStrikingDistanceRow[]
  countries: GSCPerformanceRow[]
}

export type GSCPerformanceMetrics = {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export type GSCPerformanceRow = GSCPerformanceMetrics & {
  key: string
}

export type GSCStrikingDistanceRow = Omit<GSCPerformanceMetrics, "ctr"> & {
  query: string
  page: string
}

export type GSCPerformanceTable = {
  dimension: GSCPerformanceDimension
  page: number
  pageSize: GSCPerformancePageSize
  hasNextPage: boolean
  rows: GSCPerformanceRow[]
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

type GSCPerformanceReportResponse = {
  site_url: string
  range: {
    start_date: string
    end_date: string
    previous_start_date: string
    previous_end_date: string
  }
  totals: GSCPerformanceMetrics
  previous_totals: GSCPerformanceMetrics
  striking_distance: Array<{
    query: string
    page: string
    clicks: number
    impressions: number
    position: number
  }>
  countries: Array<{ key: string } & GSCPerformanceMetrics>
}

type GSCPerformanceTableResponse = {
  dimension: GSCPerformanceDimension
  page: number
  page_size: GSCPerformancePageSize
  has_next_page: boolean
  rows: Array<{ key: string } & GSCPerformanceMetrics>
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
  filters: GSCPerformanceFilters = { dateRange: "last_28_days" }
): Promise<GSCPerformanceReport> {
  const result = await apiRequest<GSCPerformanceReportResponse>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/gsc/performance?${gscPerformanceParams(filters)}`
  )
  return {
    siteUrl: result.site_url,
    range: {
      startDate: result.range.start_date,
      endDate: result.range.end_date,
      previousStartDate: result.range.previous_start_date,
      previousEndDate: result.range.previous_end_date,
    },
    totals: result.totals,
    previousTotals: result.previous_totals,
    strikingDistance: result.striking_distance,
    countries: result.countries,
  }
}

export async function getGSCPerformanceTable(
  projectId: string,
  input: GSCPerformanceFilters & {
    dimension: GSCPerformanceDimension
    page: number
    pageSize: GSCPerformancePageSize
  }
): Promise<GSCPerformanceTable> {
  const params = gscPerformanceParams(input)
  params.set("dimension", input.dimension)
  params.set("page", String(input.page))
  params.set("page_size", String(input.pageSize))
  const result = await apiRequest<GSCPerformanceTableResponse>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/gsc/performance/table?${params}`
  )
  return {
    dimension: result.dimension,
    page: result.page,
    pageSize: result.page_size,
    hasNextPage: result.has_next_page,
    rows: result.rows,
  }
}

export async function exportGSCPerformance(
  projectId: string,
  input: GSCPerformanceFilters & { dimension: GSCPerformanceDimension }
): Promise<GSCPerformanceRow[]> {
  const params = gscPerformanceParams(input)
  params.set("dimension", input.dimension)
  const result = await apiRequest<{
    dimension: GSCPerformanceDimension
    rows: Array<{ key: string } & GSCPerformanceMetrics>
  }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/gsc/performance/export?${params}`
  )
  return result.rows
}

function gscPerformanceParams(filters: GSCPerformanceFilters): URLSearchParams {
  const params = new URLSearchParams({ date_range: filters.dateRange })
  if (filters.device) params.set("device", filters.device)
  if (filters.country) params.set("country", filters.country)
  return params
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
