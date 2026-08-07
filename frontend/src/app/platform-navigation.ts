import { BarChart3, Settings2, SlidersHorizontal } from "lucide-react"

import type { NavigationItem } from "@/app/module-contract"
import { registeredModuleNavigation } from "@/app/module-registry"

export const performanceNavigation: NavigationItem = {
  id: "performance",
  label: "效果",
  description: "统一查看搜索、内容和转化表现",
  icon: BarChart3,
  tabs: [
    { id: "search", label: "搜索表现" },
    { id: "content", label: "内容表现" },
    { id: "links", label: "链接监控" },
    { id: "reports", label: "客户报告" },
  ],
  action: "导出报告",
}

export const settingsNavigation: NavigationItem = {
  id: "settings",
  label: "设置",
  description: "管理当前项目的业务资料与服务连接",
  icon: Settings2,
  tabs: [
    { id: "business", label: "业务资料" },
    { id: "connections", label: "服务连接" },
  ],
  action: "",
}

export const platformSettingsNavigation: NavigationItem = {
  id: "platform-settings",
  label: "平台设置",
  description: "管理平台使用的 AI 模型与数据服务",
  icon: SlidersHorizontal,
  tabs: [
    { id: "ai", label: "AI 模型" },
    { id: "dataforseo", label: "DataForSEO" },
  ],
  action: "",
}

export const workspaceNavigation: readonly NavigationItem[] = [
  ...registeredModuleNavigation,
  performanceNavigation,
]

export const allNavigation: readonly NavigationItem[] = [
  ...workspaceNavigation,
  settingsNavigation,
  platformSettingsNavigation,
]

export function getNavigationItem(moduleId: string) {
  return allNavigation.find((item) => item.id === moduleId)
}

export function getModulePath(projectId: string, module: NavigationItem) {
  const firstView = module.tabs[0]?.id
  return firstView
    ? `/projects/${projectId}/${module.id}/${firstView}`
    : `/projects/${projectId}/${module.id}`
}
