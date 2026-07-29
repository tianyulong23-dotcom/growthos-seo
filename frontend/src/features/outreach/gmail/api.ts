import { apiRequest } from "@/api/client"
import type {
  GmailConnectResponse,
  GmailDisconnectResponse,
  GmailStatusResponse,
} from "@/features/outreach/gmail/types"

const gmailConnectionPath = (websiteProjectKey: string) =>
  `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}/backlinks/gmail-connections`

export function getGmailConnectionStatus(websiteProjectKey: string) {
  return apiRequest<GmailStatusResponse>(
    `${gmailConnectionPath(websiteProjectKey)}/status`
  )
}

export function startGmailConnection(
  websiteProjectKey: string,
  returnPath: string
) {
  return apiRequest<GmailConnectResponse>(
    `${gmailConnectionPath(websiteProjectKey)}/connect`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ returnPath }),
    }
  )
}

export function disconnectGmailConnection(
  websiteProjectKey: string,
  connectionId: string,
  expectedVersion: number
) {
  return apiRequest<GmailDisconnectResponse>(
    `${gmailConnectionPath(websiteProjectKey)}/${encodeURIComponent(connectionId)}/disconnect`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion }),
    }
  )
}
