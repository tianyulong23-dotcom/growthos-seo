import { Link2 } from "lucide-react"

import type { NavigationItem } from "@/app/module-contract"

export const backlinksNavigation: NavigationItem = {
  id: "backlinks",
  label: "外链",
  description: "从推荐发现、机会推进到邮件外联的统一工作区",
  icon: Link2,
  tabs: [
    { id: "recommendations", label: "推荐池" },
    { id: "opportunities", label: "外链机会" },
    { id: "email", label: "邮件中心" },
  ],
  action: "",
  badge: {
    value: "5",
    variant: "secondary",
  },
}
