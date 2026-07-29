import type { PlatformModuleRegistration } from "@/app/module-contract"
import { auditNavigation } from "@/features/audit/manifest"
import { AuditModulePage } from "@/features/audit/module"

export const auditModuleRegistration: PlatformModuleRegistration = {
  id: "audit",
  routes: [
    { path: "audit", Component: AuditModulePage },
    { path: "audit/:view", Component: AuditModulePage },
  ],
  navigation: [auditNavigation],
  requiredCapabilities: ["audit:read"],
}
