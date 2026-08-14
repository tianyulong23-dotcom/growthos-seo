import * as React from "react"
import { Link2 } from "lucide-react"
import { useParams } from "react-router"

import { backlinksNavigation } from "@/features/outreach/manifest"
import { OutreachWorkspace } from "@/features/outreach/outreach-workspace"
import { useProjects } from "@/features/projects/project-context"
import { ModulePage } from "@/pages/module-page"

export function BacklinksModulePage() {
  const [actionCount, setActionCount] = React.useState(0)
  const { projects, getProject } = useProjects()
  const { projectId = projects[0]?.id ?? "" } = useParams<{
    projectId: string
  }>()
  const project = getProject(projectId)

  return (
    <ModulePage
      module={backlinksNavigation}
      actionLabel={
        actionCount > 0 ? `已添加 ${actionCount} 项` : backlinksNavigation.action
      }
      actionIcon={<Link2 />}
      onAction={() => setActionCount((count) => count + 1)}
    >
      {(activeView) => <OutreachWorkspace view={activeView} project={project} />}
    </ModulePage>
  )
}
