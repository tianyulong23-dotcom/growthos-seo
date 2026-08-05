import type { NavigationItem } from "@/app/module-contract"
import { auditModuleRegistration } from "@/features/audit/registration"
import { contentModuleRegistration } from "@/features/content/registration"
import { keywordsModuleRegistration } from "@/features/keywords/registration"
import { backlinksModuleRegistration } from "@/features/outreach/registration"

export const platformModuleRegistrations = [
  auditModuleRegistration,
  keywordsModuleRegistration,
  contentModuleRegistration,
  backlinksModuleRegistration,
] as const

export const registeredModuleRoutes = platformModuleRegistrations.flatMap(
  (registration) => registration.routes
)

export const registeredModuleNavigation: readonly NavigationItem[] =
  platformModuleRegistrations.flatMap(
    (registration) => registration.navigation
  )
