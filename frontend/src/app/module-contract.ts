import type { LucideIcon } from "lucide-react"
import type { RouteObject } from "react-router"

export type PlatformModuleId =
  | "audit"
  | "keywords"
  | "content"
  | "backlinks"

export type NavigationItemId =
  | "overview"
  | PlatformModuleId
  | "performance"
  | "settings"

export type ModuleTab = {
  id: string
  label: string
}

export type NavigationItem = {
  id: NavigationItemId
  label: string
  description: string
  icon: LucideIcon
  tabs: readonly ModuleTab[]
  action: string
  badge?: {
    value: string
    variant: "default" | "secondary" | "destructive" | "outline"
  }
}

export type PlatformModuleRegistration = {
  id: PlatformModuleId
  routes: readonly RouteObject[]
  navigation: readonly NavigationItem[]
  requiredCapabilities: readonly string[]
}
