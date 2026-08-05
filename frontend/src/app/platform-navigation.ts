import { BarChart3, Gauge, Settings2 } from "lucide-react"

import type { NavigationItem } from "@/app/module-contract"
import { registeredModuleNavigation } from "@/app/module-registry"

export const overviewNavigation: NavigationItem = {
  id: "overview",
  label: "项目总览",
  description: "项目健康度、增长趋势与待处理事项",
  icon: Gauge,
  tabs: [],
  action: "查看报告",
}

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
  label: "项目设置",
  description: "管理项目资料、数据源与通知规则",
  icon: Settings2,
  tabs: [
    { id: "profile", label: "项目资料" },
    { id: "sources", label: "数据连接" },
    { id: "outreach", label: "外联规则" },
    { id: "notifications", label: "通知设置" },
  ],
  action: "保存设置",
}

export const workspaceNavigation: readonly NavigationItem[] = [
  ...registeredModuleNavigation,
  performanceNavigation,
]

export const allNavigation: readonly NavigationItem[] = [
  overviewNavigation,
  ...workspaceNavigation,
  settingsNavigation,
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
