import { ChevronRight } from "lucide-react"
import { Link, useParams } from "react-router"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { projects, type ModuleConfig } from "@/data/mock-data"

type PageHeaderProps = {
  module: ModuleConfig
  actionLabel?: string
  actionIcon?: React.ReactNode
  onAction?: () => void
  actionDisabled?: boolean
}

export function PageHeader({
  module,
  actionLabel,
  actionIcon,
  onAction,
  actionDisabled,
}: PageHeaderProps) {
  const { projectId = projects[0].id } = useParams()
  const project = projects.find((item) => item.id === projectId) ?? projects[0]

  return (
    <div className="flex flex-col gap-4 border-b px-4 py-5 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
          <Link
            to={`/projects/${project.id}/overview`}
            className="truncate hover:text-foreground"
          >
            {project.name}
          </Link>
          <ChevronRight className="size-3.5 shrink-0" />
          <span>{module.label}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{module.label}</h1>
          {module.id === "audit" && (
            <Badge variant="secondary">健康度 {project.health}</Badge>
          )}
        </div>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {module.description}
        </p>
      </div>
      {actionLabel && (
        <Button
          className="self-start lg:self-auto"
          onClick={onAction}
          disabled={actionDisabled}
        >
          {actionIcon}
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
