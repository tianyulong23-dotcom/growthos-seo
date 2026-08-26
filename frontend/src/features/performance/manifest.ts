import { BarChart3 } from "lucide-react"

import type { NavigationItem } from "@/app/module-contract"

export const performanceNavigation: NavigationItem = {
  id: "performance",
  label: "效果",
  description: "查看平台文章与外链的真实表现",
  icon: BarChart3,
  tabs: [
    { id: "overview", label: "总览" },
    { id: "articles", label: "文章效果" },
    { id: "backlinks", label: "外链监控" },
  ],
  action: "",
}
