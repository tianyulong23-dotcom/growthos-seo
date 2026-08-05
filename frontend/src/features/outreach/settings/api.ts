import { ApiError } from "@/api/client"
import { requestBacklinks } from "@/api/generated/backlinks"

import type {
  KillSwitchView,
  SettingsClient,
  SettingsGovernanceView,
  SettingsVersion,
  UpdateKillSwitchInput,
  UpdateSettingsInput,
} from "./types"

export function isSettingsApiStatus(
  error: unknown,
  status: number
): error is ApiError {
  return error instanceof ApiError && error.status === status
}

export async function getSettings(
  websiteProjectKey: string,
  signal?: AbortSignal
): Promise<SettingsGovernanceView> {
  return requestBacklinks(
    "backlinksGetSettingsGovernanceV1",
    { path: { websiteProjectKey } },
    { signal }
  )
}

export async function updateSettings(
  websiteProjectKey: string,
  input: UpdateSettingsInput
): Promise<{ settings: SettingsVersion }> {
  return requestBacklinks("backlinksUpdateSettingsV1", {
    path: { websiteProjectKey },
    body: input,
  })
}

export async function updateKillSwitch(
  websiteProjectKey: string,
  capability: string,
  input: UpdateKillSwitchInput
): Promise<{ killSwitch: KillSwitchView }> {
  return requestBacklinks("backlinksUpdateKillSwitchV1", {
    path: { websiteProjectKey, capability },
    body: input,
  })
}

export const settingsClient: SettingsClient = {
  getSettings,
  updateSettings,
  updateKillSwitch,
}
