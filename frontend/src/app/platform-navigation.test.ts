import { describe, expect, it } from "vitest"

import {
  platformSettingsNavigation,
  settingsNavigation,
} from "@/app/platform-navigation"
import { modules } from "@/data/mock-data"

const expectedProjectTabs = [
  ["business", "业务资料"],
  ["connections", "服务连接"],
]

const expectedPlatformTabs = [
  ["ai", "AI 模型"],
  ["dataforseo", "DataForSEO"],
  ["google-oauth", "Google OAuth"],
]

describe("settings navigation", () => {
  it("separates project settings from platform settings", () => {
    expect(settingsNavigation.tabs.map(({ id, label }) => [id, label])).toEqual(
      expectedProjectTabs
    )
    expect(
      platformSettingsNavigation.tabs.map(({ id, label }) => [id, label])
    ).toEqual(expectedPlatformTabs)
    expect(
      modules
        .find((module) => module.id === "settings")
        ?.tabs.map(({ id, label }) => [id, label])
    ).toEqual(expectedProjectTabs)
    expect(
      modules
        .find((module) => module.id === "platform-settings")
        ?.tabs.map(({ id, label }) => [id, label])
    ).toEqual(expectedPlatformTabs)
  })
})
