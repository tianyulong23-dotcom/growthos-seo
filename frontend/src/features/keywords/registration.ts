import type { PlatformModuleRegistration } from "@/app/module-contract"
import { keywordsNavigation } from "@/features/keywords/manifest"
import { KeywordsModulePage } from "@/features/keywords/module"

export const keywordsModuleRegistration: PlatformModuleRegistration = {
  id: "keywords",
  routes: [
    { path: "keywords", Component: KeywordsModulePage },
    { path: "keywords/:view", Component: KeywordsModulePage },
  ],
  navigation: [keywordsNavigation],
  requiredCapabilities: ["keywords:read"],
}
