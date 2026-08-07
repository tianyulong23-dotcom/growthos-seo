import { apiRequest } from "@/api/client"

export type ConnectionStatus = "connected" | "disconnected"

export type GSCConnection = {
  propertyUrl: string
  serviceAccountEmail: string
  privateKeyConfigured: boolean
  status: ConnectionStatus
  verifiedAt: string | null
}

export type GSCConnectionInput = {
  propertyUrl: string
  serviceAccountEmail: string
  privateKey?: string
}

export type WordPressConnection = {
  siteUrl: string
  username: string
  applicationPasswordConfigured: boolean
  verifiedUser: string | null
  status: ConnectionStatus
  verifiedAt: string | null
}

export type WordPressConnectionInput = {
  siteUrl: string
  username: string
  applicationPassword?: string
}

type GSCResponse = {
  property_url: string
  service_account_email: string
  private_key_configured: boolean
  status: ConnectionStatus
  verified_at: string | null
}

type WordPressResponse = {
  site_url: string
  username: string
  application_password_configured: boolean
  verified_user: string | null
  status: ConnectionStatus
  verified_at: string | null
}

const connectionPath = (projectId: string) =>
  `/api/v1/projects/${encodeURIComponent(projectId)}/service-connections`

function mapGSC(value: GSCResponse): GSCConnection {
  return {
    propertyUrl: value.property_url,
    serviceAccountEmail: value.service_account_email,
    privateKeyConfigured: value.private_key_configured,
    status: value.status,
    verifiedAt: value.verified_at,
  }
}

function mapWordPress(value: WordPressResponse): WordPressConnection {
  return {
    siteUrl: value.site_url,
    username: value.username,
    applicationPasswordConfigured: value.application_password_configured,
    verifiedUser: value.verified_user,
    status: value.status,
    verifiedAt: value.verified_at,
  }
}

function gscBody(input: GSCConnectionInput) {
  return {
    property_url: input.propertyUrl,
    service_account_email: input.serviceAccountEmail,
    ...(input.privateKey ? { private_key: input.privateKey } : {}),
  }
}

function wordpressBody(input: WordPressConnectionInput) {
  return {
    site_url: input.siteUrl,
    username: input.username,
    ...(input.applicationPassword
      ? { application_password: input.applicationPassword }
      : {}),
  }
}

export async function getGSCConnection(projectId: string) {
  return mapGSC(
    await apiRequest<GSCResponse>(`${connectionPath(projectId)}/gsc`)
  )
}

export async function saveGSCConnection(
  projectId: string,
  input: GSCConnectionInput
) {
  return mapGSC(
    await apiRequest<GSCResponse>(`${connectionPath(projectId)}/gsc`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gscBody(input)),
    })
  )
}

export function testGSCConnection(
  projectId: string,
  input: GSCConnectionInput
) {
  return apiRequest<{ success: boolean; message: string }>(
    `${connectionPath(projectId)}/gsc/test`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gscBody(input)),
    }
  )
}

export function disconnectGSCConnection(projectId: string) {
  return apiRequest<void>(`${connectionPath(projectId)}/gsc`, {
    method: "DELETE",
  })
}

export async function getWordPressConnection(projectId: string) {
  return mapWordPress(
    await apiRequest<WordPressResponse>(
      `${connectionPath(projectId)}/wordpress`
    )
  )
}

export async function saveWordPressConnection(
  projectId: string,
  input: WordPressConnectionInput
) {
  return mapWordPress(
    await apiRequest<WordPressResponse>(
      `${connectionPath(projectId)}/wordpress`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wordpressBody(input)),
      }
    )
  )
}

export function testWordPressConnection(
  projectId: string,
  input: WordPressConnectionInput
) {
  return apiRequest<{ success: boolean; message: string }>(
    `${connectionPath(projectId)}/wordpress/test`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wordpressBody(input)),
    }
  )
}

export function disconnectWordPressConnection(projectId: string) {
  return apiRequest<void>(`${connectionPath(projectId)}/wordpress`, {
    method: "DELETE",
  })
}
