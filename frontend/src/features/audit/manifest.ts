import { SearchCheck } from "lucide-react"

import type { NavigationItem } from "@/app/module-contract"

export const auditNavigation: NavigationItem = {
  id: "audit",
  label: "网站审计",
  description: "持续发现并修复影响抓取、索引和体验的问题",
  icon: SearchCheck,
  tabs: [
    { id: "overview", label: "审计概览" },
    { id: "issues", label: "问题清单" },
    { id: "pages", label: "页面资源" },
  ],
  action: "立即扫描",
  badge: {
    value: "29",
    variant: "destructive",
  },
}
