import * as React from "react"
import { Link2 } from "lucide-react"

import { backlinksNavigation } from "@/features/outreach/manifest"
import { OutreachWorkspace } from "@/features/outreach/outreach-workspace"
import { ModulePage } from "@/pages/module-page"

export function BacklinksModulePage() {
  const [actionCount, setActionCount] = React.useState(0)

  return (
    <ModulePage
      module={backlinksNavigation}
      actionLabel={
        actionCount > 0 ? `已添加 ${actionCount} 项` : backlinksNavigation.action
      }
      actionIcon={<Link2 />}
      onAction={() => setActionCount((count) => count + 1)}
    >
      {(activeView) => <OutreachWorkspace view={activeView} />}
    </ModulePage>
  )
}
