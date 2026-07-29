import type { PlatformModuleRegistration } from "@/app/module-contract"
import { contentNavigation } from "@/features/content/manifest"
import { ContentModulePage } from "@/features/content/module"

export const contentModuleRegistration: PlatformModuleRegistration = {
  id: "content",
  routes: [
    { path: "content", Component: ContentModulePage },
    { path: "content/:view", Component: ContentModulePage },
  ],
  navigation: [contentNavigation],
  requiredCapabilities: ["content:read"],
}
