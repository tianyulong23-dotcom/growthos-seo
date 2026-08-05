import * as React from "react"
import { Download } from "lucide-react"
import { useParams } from "react-router"

import { performanceNavigation } from "@/app/platform-navigation"
import { useCurrentProject } from "@/app/project-context"
import { PerformanceWorkspace } from "@/features/performance/performance-workspace"
import { ModulePage } from "@/pages/module-page"

export function PerformancePage() {
  const { currentProject } = useCurrentProject()
  const { view } = useParams<{ view?: string }>()
  if (!currentProject) {
    throw new Error("PerformancePage requires an authorized current project.")
  }
  const projectId = currentProject.id
  const [actionCount, setActionCount] = React.useState(0)
  const usesBacklinksWorkspace = view === "links" || view === "reports"

  return (
    <ModulePage
      module={performanceNavigation}
      actionLabel={
        usesBacklinksWorkspace
          ? undefined
          : actionCount > 0
            ? `已添加 ${actionCount} 项`
            : performanceNavigation.action
      }
      actionIcon={usesBacklinksWorkspace ? undefined : <Download />}
      onAction={
        usesBacklinksWorkspace
          ? undefined
          : () => setActionCount((count) => count + 1)
      }
    >
      {(activeView) => (
        <PerformanceWorkspace view={activeView} websiteProjectKey={projectId} />
      )}
    </ModulePage>
  )
}
