import * as React from "react"
import { LoaderCircle } from "lucide-react"
import { useParams } from "react-router"

import { keywordsNavigation } from "@/features/keywords/manifest"
import { useProjects } from "@/features/projects/project-context"
import { ModulePage } from "@/pages/module-page"

const KeywordWorkspace = React.lazy(() =>
  import("@/features/keywords/keyword-workspace").then((module) => ({
    default: module.KeywordWorkspace,
  }))
)

export function KeywordsModulePage() {
  const { projects } = useProjects()
  const { projectId = projects[0]?.id ?? "" } = useParams<{
    projectId: string
  }>()
  const project = projects.find((item) => item.id === projectId)

  return (
    <ModulePage module={keywordsNavigation}>
      {(activeView) => (
        <React.Suspense
          fallback={
            <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
              <LoaderCircle className="mr-2 size-4 animate-spin" />
              正在加载关键词
            </div>
          }
        >
          <KeywordWorkspace
            key={projectId}
            projectId={projectId}
            view={activeView}
            savedCompetitorDomain={project?.competitorDomain}
          />
        </React.Suspense>
      )}
    </ModulePage>
  )
}
