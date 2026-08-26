import * as React from "react"
import {
  Archive,
  Command,
  LoaderCircle,
  Moon,
  Plus,
  RotateCcw,
  Sun,
} from "lucide-react"
import { Link } from "react-router"

import { CreateProjectDialog } from "@/features/projects/create-project-dialog"
import { ProjectFavicon } from "@/features/projects/project-favicon"
import { useProjects } from "@/features/projects/project-context"
import { formatProjectMarket } from "@/features/projects/project-options"
import { useTheme } from "@/components/theme-provider"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Project } from "@/features/projects/types"

export function ProjectsPage() {
  const { projects, archivedProjects, archiveProject, restoreProject } =
    useProjects()
  const { theme, setTheme } = useTheme()
  const [createOpen, setCreateOpen] = React.useState(false)
  const [view, setView] = React.useState<"active" | "archived">("active")
  const [projectAction, setProjectAction] = React.useState<{
    project: Project
    type: "archive" | "restore"
  } | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [actionError, setActionError] = React.useState("")
  const visibleProjects = view === "active" ? projects : archivedProjects

  async function handleProjectAction() {
    if (!projectAction) {
      return
    }
    setSubmitting(true)
    setActionError("")
    try {
      if (projectAction.type === "archive") {
        await archiveProject(projectAction.project.id)
      } else {
        await restoreProject(projectAction.project.id)
      }
      setProjectAction(null)
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "更新项目状态失败"
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center px-4 sm:px-6">
          <Link to="/projects" className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Command className="size-4.5" />
            </span>
            <span className="text-sm font-semibold">SEO 工作台</span>
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label="切换主题"
              title="切换主题"
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
            <Avatar className="ml-1 size-8">
              <AvatarFallback className="bg-foreground text-xs text-background">
                林
              </AvatarFallback>
            </Avatar>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">项目</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              选择项目继续工作
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            新建项目
          </Button>
        </div>

        <Tabs
          value={view}
          onValueChange={(value) => setView(value as "active" | "archived")}
          className="mb-4"
        >
          <TabsList>
            <TabsTrigger value="active">进行中 {projects.length}</TabsTrigger>
            <TabsTrigger value="archived">
              已归档 {archivedProjects.length}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <Card className="gap-0 rounded-lg py-0">
          <div className="hidden grid-cols-2 items-center gap-x-4 border-b px-5 py-3 pr-16 text-xs font-medium text-muted-foreground md:grid">
            <span>网站</span>
            <span>市场</span>
          </div>
          <div className="divide-y">
            {visibleProjects.map((project) => (
              <div
                key={project.id}
                className="group relative grid min-h-16 grid-cols-1 items-center gap-x-4 px-5 py-2.5 pr-16 transition-colors hover:bg-muted/30 md:grid-cols-2"
              >
                {view === "active" && (
                  <Link
                    to={`/projects/${project.id}/audit/overview`}
                    className="absolute inset-0 z-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                    aria-label={`进入 ${project.name}`}
                  />
                )}

                <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-3">
                  <ProjectFavicon project={project} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {project.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {project.domain}
                    </span>
                  </span>
                </div>

                <span className="pointer-events-none relative z-10 hidden text-sm md:block">
                  {formatProjectMarket(project.country, project.language)}
                </span>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-1/2 right-4 z-20 -translate-y-1/2 text-muted-foreground opacity-60 transition-opacity hover:text-foreground hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`${
                    view === "active" ? "归档" : "恢复"
                  } ${project.name}`}
                  title={view === "active" ? "归档项目" : "恢复项目"}
                  onClick={() => {
                    setProjectAction({
                      project,
                      type: view === "active" ? "archive" : "restore",
                    })
                    setActionError("")
                  }}
                >
                  {view === "active" ? <Archive /> : <RotateCcw />}
                </Button>

                <div className="pointer-events-none relative z-10 mt-1 pl-11 md:hidden">
                  <span className="truncate text-xs text-muted-foreground">
                    {formatProjectMarket(project.country, project.language)}
                  </span>
                </div>
              </div>
            ))}
            {visibleProjects.length === 0 && (
              <div className="px-5 py-12 text-center text-sm text-muted-foreground">
                {view === "active" ? "暂无进行中的项目" : "暂无已归档项目"}
              </div>
            )}
          </div>
        </Card>
      </main>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />

      <Dialog
        open={projectAction !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) {
            setProjectAction(null)
            setActionError("")
          }
        }}
      >
        <DialogContent showCloseButton={!submitting}>
          <DialogHeader>
            <DialogTitle>
              {projectAction?.type === "archive" ? "归档项目" : "恢复项目"}
            </DialogTitle>
            <DialogDescription>
              {projectAction?.type === "archive"
                ? `归档 ${projectAction.project.name} 后，历史数据仍会保留。`
                : `恢复 ${projectAction?.project.name} 后，可继续进入项目工作区。`}
            </DialogDescription>
          </DialogHeader>
          {actionError && (
            <p className="text-sm text-destructive">{actionError}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setProjectAction(null)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button
              onClick={() => void handleProjectAction()}
              disabled={submitting}
            >
              {submitting && <LoaderCircle className="animate-spin" />}
              {submitting
                ? "处理中..."
                : projectAction?.type === "archive"
                  ? "确认归档"
                  : "确认恢复"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
