import { ApiError, apiRequest } from "@/api/client"

import type {
  SettingsClient,
  SettingsGovernanceView,
  SettingsVersion,
  UpdateKillSwitchInput,
  UpdateSettingsInput,
  KillSwitchView,
} from "./types"

const settingsPath = (websiteProjectKey: string) =>
  `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}/backlinks/settings`

export function isSettingsApiStatus(
  error: unknown,
  status: number
): error is ApiError {
  return error instanceof ApiError && error.status === status
}

export async function getSettings(
  websiteProjectKey: string
): Promise<SettingsGovernanceView> {
  return apiRequest<SettingsGovernanceView>(settingsPath(websiteProjectKey))
}

export async function updateSettings(
  websiteProjectKey: string,
  input: UpdateSettingsInput
): Promise<{ settings: SettingsVersion }> {
  return apiRequest<{ settings: SettingsVersion }>(
    settingsPath(websiteProjectKey),
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: input.expectedVersion,
        values: input.values,
      }),
    }
  )
}

export async function updateKillSwitch(
  websiteProjectKey: string,
  capability: string,
  input: UpdateKillSwitchInput
): Promise<{ killSwitch: KillSwitchView }> {
  return apiRequest<{ killSwitch: KillSwitchView }>(
    `${settingsPath(websiteProjectKey)}/kill-switches/${encodeURIComponent(capability)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: input.expectedVersion,
        layer: input.layer,
        provider: input.provider,
        blocked: input.blocked,
        confirmation: input.confirmation,
        reason: input.reason,
      }),
    }
  )
}

export const settingsClient: SettingsClient = {
  getSettings,
  updateSettings,
  updateKillSwitch,
}
