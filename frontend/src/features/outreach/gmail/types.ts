export type GmailConnectionStatus =
  | "CONNECTING"
  | "CONNECTED"
  | "REAUTH_REQUIRED"
  | "TOKEN_REVOKED"
  | "DISCONNECTED"

export type GmailConnectionView = {
  connectionId: string
  version: number
  primaryEmail: string
  displayName: string | null
  hostedDomain: string | null
  grantedScopes: string[]
  connectionStatus: GmailConnectionStatus
  sendAvailability: "AVAILABLE" | "PAUSED"
  mailSyncCapability: boolean
  tokenExpiresAt: string
  connectedAt: string
  affectedProjectCount: number
  recentErrorCategory: string | null
}

export type GmailConnectionMeta = {
  organizationId: string
  workspaceId: string
  websiteProjectId: string
  requestId: string
  schemaVersion: "backlinks.v1"
  generatedAt: string
}

export type GmailStatusResponse = {
  connection: GmailConnectionView | null
  accounts: GmailConnectionView[]
  meta: GmailConnectionMeta
}

export type GmailConnectResponse = {
  authorizationUrl: string
  expiresAt: string
  meta: GmailConnectionMeta
}

export type GmailDisconnectResponse = {
  connection: GmailConnectionView
  revocationStatus: "COMPLETED" | "PENDING"
  meta: GmailConnectionMeta
}
