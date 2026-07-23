import * as React from "react"
import { Command, LoaderCircle, Moon, Plus, Sun, Trash2 } from "lucide-react"
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
import type { Project } from "@/features/projects/types"

export function ProjectsPage() {
  const { projects, deleteProject } = useProjects()
  const { theme, setTheme } = useTheme()
  const [createOpen, setCreateOpen] = React.useState(false)
  const [projectToDelete, setProjectToDelete] = React.useState<Project | null>(
    null
  )
  const [deleting, setDeleting] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState("")

  async function handleDeleteProject() {
    if (!projectToDelete) {
      return
    }
    setDeleting(true)
    setDeleteError("")
    try {
      await deleteProject(projectToDelete.id)
      setProjectToDelete(null)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除项目失败")
    } finally {
      setDeleting(false)
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

        <Card className="gap-0 rounded-lg py-0">
          <div className="hidden grid-cols-2 items-center gap-x-4 border-b px-5 py-3 pr-16 text-xs font-medium text-muted-foreground md:grid">
            <span>网站</span>
            <span>市场</span>
          </div>
          <div className="divide-y">
            {projects.map((project) => (
              <div
                key={project.id}
                className="group relative grid min-h-16 grid-cols-1 items-center gap-x-4 px-5 py-2.5 pr-16 transition-colors hover:bg-muted/30 md:grid-cols-2"
              >
                <Link
                  to={`/projects/${project.id}/overview`}
                  className="absolute inset-0 z-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                  aria-label={`进入 ${project.name}`}
                />

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
                  className="absolute top-1/2 right-4 z-20 -translate-y-1/2 text-muted-foreground opacity-50 transition-opacity hover:text-destructive hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`删除 ${project.name}`}
                  title="删除项目"
                  onClick={() => {
                    setProjectToDelete(project)
                    setDeleteError("")
                  }}
                >
                  <Trash2 />
                </Button>

                <div className="pointer-events-none relative z-10 mt-1 pl-11 md:hidden">
                  <span className="truncate text-xs text-muted-foreground">
                    {formatProjectMarket(project.country, project.language)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </main>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />

      <Dialog
        open={projectToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setProjectToDelete(null)
            setDeleteError("")
          }
        }}
      >
        <DialogContent showCloseButton={!deleting}>
          <DialogHeader>
            <DialogTitle>删除项目</DialogTitle>
            <DialogDescription>
              将删除 {projectToDelete?.name}{" "}
              及其网站抓取和技术审计数据。此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-sm text-destructive">{deleteError}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setProjectToDelete(null)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDeleteProject()}
              disabled={deleting}
            >
              {deleting && <LoaderCircle className="animate-spin" />}
              {deleting ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
