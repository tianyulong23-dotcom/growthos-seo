import type {
  BacklinksRequest,
  BacklinksResponse,
} from "@/api/generated/backlinks"

export type SettingsGovernanceView =
  BacklinksResponse<"backlinksGetSettingsGovernanceV1">
export type SettingsVersion = SettingsGovernanceView["settings"]
export type SettingsValues = SettingsVersion["values"]
export type KillSwitchView = SettingsGovernanceView["killSwitches"][number]
export type KillSwitchLayer =
  SettingsGovernanceView["editableKillSwitchLayers"][number]
export type KillSwitchSourceLayer = KillSwitchView["sourceLayer"]
export type RetentionPolicyView = SettingsGovernanceView["retention"]
export type RetentionException = RetentionPolicyView["exceptions"][number]
export type UpdateSettingsInput =
  BacklinksRequest<"backlinksUpdateSettingsV1">["body"]
export type UpdateKillSwitchInput =
  BacklinksRequest<"backlinksUpdateKillSwitchV1">["body"]

export type SettingsClient = {
  getSettings(
    websiteProjectKey: string,
    signal?: AbortSignal
  ): Promise<SettingsGovernanceView>
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
