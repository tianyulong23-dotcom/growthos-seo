import { describe, expect, it } from "vitest"

import {
  performanceNavigation,
  platformSettingsNavigation,
  settingsNavigation,
} from "@/app/platform-navigation"
import { modules } from "@/data/mock-data"
import { backlinksNavigation } from "@/features/outreach/manifest"

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

describe("backlinks navigation", () => {
  it("uses the outreach module navigation without project creation", () => {
    const configuredBacklinks = modules.find(
      (module) => module.id === "backlinks"
    )

    expect(configuredBacklinks).toBe(backlinksNavigation)
    expect(
      configuredBacklinks?.tabs.map(({ id, label }) => [id, label])
    ).toEqual([
      ["recommendations", "推荐池"],
      ["opportunities", "外链机会"],
      ["email", "邮件中心"],
    ])
  })
})

describe("performance navigation", () => {
  it("adds backlink effects without replacing article performance", () => {
    expect(modules.find((module) => module.id === "performance")).toBe(
      performanceNavigation
    )
    expect(
      performanceNavigation.tabs.map(({ id, label }) => [id, label])
    ).toEqual([
      ["overview", "总览"],
      ["articles", "文章效果"],
      ["backlinks", "外链监控"],
      ["reports", "指标报告"],
    ])
  })
})
