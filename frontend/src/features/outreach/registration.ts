import type { PlatformModuleRegistration } from "@/app/module-contract"
import { DraftPage } from "@/features/outreach/drafts/draft-page"
import { backlinksNavigation } from "@/features/outreach/manifest"
import { BacklinksModulePage } from "@/features/outreach/module"

export const backlinksModuleRegistration: PlatformModuleRegistration = {
  id: "backlinks",
  routes: [
    { path: "backlinks", Component: BacklinksModulePage },
    { path: "backlinks/drafts/:draftId", Component: DraftPage },
    { path: "backlinks/:view", Component: BacklinksModulePage },
  ],
  navigation: [backlinksNavigation],
  requiredCapabilities: ["backlinks:read"],
}
