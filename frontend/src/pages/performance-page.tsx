import { useNavigate, useParams } from "react-router"

import { performanceNavigation } from "@/app/platform-navigation"
import { PerformanceWorkspace } from "@/features/performance/performance-workspace"
import { ModulePage } from "@/pages/module-page"

export function PerformancePage() {
  const navigate = useNavigate()
  const { projectId = "" } = useParams<{ projectId: string }>()

  return (
    <ModulePage
      module={performanceNavigation}
    >
      {(activeView) => (
        <PerformanceWorkspace
          view={activeView}
          projectId={projectId}
          onOpenArticle={(articleId) =>
            navigate(
              `/projects/${projectId}/content/articles/${encodeURIComponent(articleId)}/edit`
            )
          }
        />
      )}
    </ModulePage>
  )
}
