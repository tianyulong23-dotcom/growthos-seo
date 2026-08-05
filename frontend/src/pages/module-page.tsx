import type * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"

import type { NavigationItem } from "@/app/module-contract"
import { useCurrentProject } from "@/app/project-context"
import { PageHeader } from "@/components/shared/page-header"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

type ModulePageProps = {
  module: NavigationItem
  children: (activeView: string) => React.ReactNode
  actionLabel?: string
  actionIcon?: React.ReactNode
  onAction?: () => void
  actionDisabled?: boolean
  beforeContent?: React.ReactNode
}

export function ModulePage({
  module,
  children,
  actionLabel,
  actionIcon,
  onAction,
  actionDisabled,
  beforeContent,
}: ModulePageProps) {
  const navigate = useNavigate()
  const { currentProject } = useCurrentProject()
  const { view } = useParams<{ view?: string }>()
  if (!currentProject) {
    throw new Error("ModulePage requires an authorized current project.")
  }
  const projectId = currentProject.id
  const activeView = view ?? module.tabs[0]?.id

  if (!activeView) {
    return <Navigate to={`/projects/${projectId}/overview`} replace />
  }

  if (!module.tabs.some((tab) => tab.id === activeView)) {
    return (
      <Navigate
        to={`/projects/${projectId}/${module.id}/${module.tabs[0].id}`}
        replace
      />
    )
  }

  return (
    <div className="min-w-0">
      <PageHeader
        module={module}
        actionLabel={actionLabel}
        actionIcon={actionIcon}
        onAction={onAction}
        actionDisabled={actionDisabled}
      />
      <div className="border-b px-4 sm:px-6 lg:px-8">
        <Tabs
          value={activeView}
          onValueChange={(nextView) =>
            navigate(`/projects/${projectId}/${module.id}/${nextView}`)
          }
        >
          <TabsList
            variant="line"
            className="h-11 max-w-full justify-start overflow-x-auto"
          >
            {module.tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="min-w-0 p-4 sm:p-6 lg:p-8">
        {beforeContent}
        {children(activeView)}
      </div>
    </div>
  )
}
