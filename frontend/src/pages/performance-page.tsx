import * as React from "react"
import { Download } from "lucide-react"

import { performanceNavigation } from "@/app/platform-navigation"
import { PerformanceWorkspace } from "@/features/performance/performance-workspace"
import { ModulePage } from "@/pages/module-page"

export function PerformancePage() {
  const [actionCount, setActionCount] = React.useState(0)

  return (
    <ModulePage
      module={performanceNavigation}
      actionLabel={
        actionCount > 0
          ? `已添加 ${actionCount} 项`
          : performanceNavigation.action
      }
      actionIcon={<Download />}
      onAction={() => setActionCount((count) => count + 1)}
    >
      {(activeView) => <PerformanceWorkspace view={activeView} />}
    </ModulePage>
  )
}
