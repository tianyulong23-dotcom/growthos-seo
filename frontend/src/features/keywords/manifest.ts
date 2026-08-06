import { KeyRound } from "lucide-react"

import type { NavigationItem } from "@/app/module-contract"

export const keywordsNavigation: NavigationItem = {
  id: "keywords",
  label: "关键词",
  description: "管理关键词库，发现机会并跟踪搜索排名",
  icon: KeyRound,
  tabs: [
    { id: "library", label: "关键词库" },
    { id: "search-performance", label: "搜索表现" },
    { id: "competitor-gap", label: "竞品差距" },
  ],
  action: "",
}
