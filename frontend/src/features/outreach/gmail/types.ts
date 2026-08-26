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

export type GmailReadinessBlockerCode =
  | "GMAIL_ACCOUNT_NOT_SELECTED"
  | "GMAIL_OAUTH_CONNECTING"
  | "GMAIL_REAUTH_REQUIRED"
  | "GMAIL_TOKEN_REFRESH_FAILED"
  | "GMAIL_TOKEN_REVOKED"
  | "GMAIL_DISCONNECTED"
  | "PROJECT_BINDING_MISSING"
  | "GMAIL_SEND_SCOPE_MISSING"
  | "GMAIL_SYNC_SCOPE_MISSING"
  | "GMAIL_SEND_IDENTITY_UNVERIFIED"
  | "GMAIL_SECRET_UNRESOLVABLE"
  | "GMAIL_SEND_PAUSED"
  | "GMAIL_SEND_RUNTIME_DISABLED"
  | "GMAIL_SYNC_RUNTIME_DISABLED"
  | "GMAIL_WORKER_UNAVAILABLE"
  | "SEND_CONTEXT_REQUIRED"
  | "APPROVED_SEND_SNAPSHOT_MISSING"
  | "SEND_SUPPRESSION_BLOCKED"
  | "SEND_QUOTA_UNAVAILABLE"
  | "GMAIL_SYNC_KILL_SWITCH_CLOSED"
  | "GMAIL_SYNC_STATUS_UNAVAILABLE"
  | "GMAIL_SYNC_CURSOR_MISSING"

export type GmailReadinessRecoveryAction =
  | "CONNECT_GMAIL"
  | "COMPLETE_GMAIL_OAUTH"
  | "REAUTHORIZE_GMAIL"
  | "SELECT_GMAIL_ACCOUNT"
  | "REPAIR_PROJECT_BINDING"
  | "GRANT_GMAIL_SEND_SCOPE"
  | "GRANT_GMAIL_SYNC_SCOPE"
  | "VERIFY_SEND_IDENTITY"
  | "REPAIR_GMAIL_SECRET"
  | "RESUME_GMAIL_SEND"
  | "ENABLE_GMAIL_SEND_RUNTIME"
  | "ENABLE_GMAIL_SYNC_RUNTIME"
  | "START_GMAIL_WORKER"
  | "OPEN_APPROVED_DRAFT"
  | "REAPPROVE_CURRENT_DRAFT"
  | "CLEAR_SEND_SUPPRESSION"
  | "WAIT_FOR_SEND_QUOTA"
  | "OPEN_GMAIL_SYNC_KILL_SWITCH"
  | "REFRESH_GMAIL_READINESS"
  | "REPAIR_GMAIL_SYNC_CURSOR"

export type GmailReadinessBlocker = {
  code: GmailReadinessBlockerCode
  capability: "CONNECTION" | "SEND" | "SYNC"
  owner: "USER" | "ADMIN" | "SYSTEM"
  retrySafe: boolean
  recoveryAction: GmailReadinessRecoveryAction
  detail: string
}

export type GmailReadinessProjection = {
  evaluatedAt: string
  connection: {
    state: "CONNECTED" | "NOT_CONNECTED"
    ready: boolean
  }
  send: {
    state: "SEND_READY" | "WAITING_FOR_SEND_CONTEXT" | "BLOCKED"
    ready: boolean
  }
  sync: {
    state: "SYNC_READY" | "WAITING_FOR_ACCEPTED_SEND" | "BLOCKED"
    ready: boolean
  }
  blockers: GmailReadinessBlocker[]
  primaryBlocker: GmailReadinessBlocker | null
}

export type GmailStatusResponse = {
  connection: GmailConnectionView | null
  accounts: GmailConnectionView[]
  readiness: GmailReadinessProjection
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
