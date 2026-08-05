import { FileText } from "lucide-react"

import type { NavigationItem } from "@/app/module-contract"

export const contentNavigation: NavigationItem = {
  id: "content",
  label: "内容",
  description: "从搜索机会到内容计划、生产和发布的完整流程",
  icon: FileText,
  tabs: [
    { id: "opportunities", label: "内容机会" },
    { id: "plans", label: "内容计划" },
    { id: "library", label: "内容库" },
  ],
  action: "创建内容",
}
