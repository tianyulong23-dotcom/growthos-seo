import { KeyRound } from "lucide-react"

import type { NavigationItem } from "@/app/module-contract"

export const keywordsNavigation: NavigationItem = {
  id: "keywords",
  label: "关键词",
  description: "管理关键词库，发现机会并跟踪搜索排名",
  icon: KeyRound,
  tabs: [
    { id: "library", label: "关键词库" },
    { id: "opportunities", label: "机会发现" },
    { id: "rankings", label: "排名跟踪" },
  ],
  action: "添加关键词",
}
