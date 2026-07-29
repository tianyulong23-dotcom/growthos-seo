export type SettingsValues = {
  reportingTimezone: string
  reportLookbackDays: number
  exportExpiryHours: number
}

export type SettingsVersion = {
  id: string
  version: number
  values: SettingsValues
}

export type KillSwitchLayer = "project" | "provider"
export type KillSwitchSourceLayer =
  | "global"
  | "organization"
  | "workspace"
  | "project"
  | "provider"
  | "default"
  | "authority_unavailable"

export type KillSwitchView = {
  capability: string
  provider: string | null
  effectiveBlocked: boolean
  sourceLayer: KillSwitchSourceLayer
  sourceScopeId: string | null
  sourceVersion: number | null
  editable: boolean
}

export type RetentionException =
  | "legal_hold"
  | "audit_record"
  | "lifecycle_record"
  | "active_suppression"

export type RetentionPolicyView = {
  id: string
  version: number
  rules: Array<{
    category: string
    retainForDays: number
  }>
  exceptions: RetentionException[]
}

export type SettingsGovernanceView = {
  settings: SettingsVersion
  killSwitches: KillSwitchView[]
  editableKillSwitchLayers: KillSwitchLayer[]
  retention: RetentionPolicyView
}

export type UpdateSettingsInput = {
  expectedVersion: number
  values: SettingsValues
}

export type UpdateKillSwitchInput = {
  expectedVersion: number
  layer: KillSwitchLayer
  provider: string | null
  blocked: boolean
  confirmation: string
  reason: string
}

export type SettingsClient = {
  getSettings(websiteProjectKey: string): Promise<SettingsGovernanceView>
  updateSettings(
    websiteProjectKey: string,
    input: UpdateSettingsInput
  ): Promise<{ settings: SettingsVersion }>
  updateKillSwitch(
    websiteProjectKey: string,
    capability: string,
    input: UpdateKillSwitchInput
  ): Promise<{ killSwitch: KillSwitchView }>
}
