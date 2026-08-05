import { Navigate, useParams } from "react-router"

import { useCurrentProject } from "@/app/project-context"
import { backlinksNavigation } from "@/features/outreach/manifest"
import { OutreachWorkspace } from "@/features/outreach/outreach-workspace"
import { ModulePage } from "@/pages/module-page"

export function BacklinksModulePage() {
  const { currentProject } = useCurrentProject()
  const { view = backlinksNavigation.tabs[0]?.id ?? "projects" } = useParams<{
    view?: string
  }>()
  if (!currentProject) {
    throw new Error("BacklinksModulePage requires an authorized current project.")
  }
  const projectId = currentProject.id
  const legacyDestinations: Partial<Record<string, string>> = {
    links: `/projects/${projectId}/performance/links`,
    reports: `/projects/${projectId}/performance/reports`,
    settings: `/projects/${projectId}/settings/outreach`,
  }
  const legacyDestination = legacyDestinations[view]

  if (legacyDestination) {
    return <Navigate to={legacyDestination} replace />
  }

  return (
    <ModulePage module={backlinksNavigation}>
      {(activeView) => <OutreachWorkspace view={activeView} />}
    </ModulePage>
  )
}
