import * as React from "react"
import { AlertCircle, CheckCircle2, Clock3, ListTodo, RefreshCw } from "lucide-react"
import { Link } from "react-router"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet"
import { useProjects } from "@/features/projects/project-context"
import { isTaskActive, taskHref, taskReasonLabel, taskSourceLabels, taskStatusLabel } from "./task-api"
import { useTasks } from "./use-tasks"

export function TaskCenter() {
  const { projects } = useProjects()
  const [open, setOpen] = React.useState(false)
  const [filter, setFilter] = React.useState("active")
  const [projectFilter, setProjectFilter] = React.useState("")
  const { snapshots, loading, refresh } = useTasks(projects.map((item) => item.id), open)
  const entries = snapshots.flatMap((snapshot) =>
    snapshot.items.map((task) => ({ task, snapshot }))
  ).sort((a, b) =>
    Number(isTaskActive(b.task)) - Number(isTaskActive(a.task)) ||
    (b.task.updated_at ?? "").localeCompare(a.task.updated_at ?? "")
  )
  const activeCount = entries.filter(({ task }) => isTaskActive(task)).length
  const visible = entries.filter(({ task, snapshot }) =>
    (!projectFilter || snapshot.projectId === projectFilter) &&
    (filter === "all" || isTaskActive(task))
  )
  const errors = snapshots.filter((item) => item.error && (!projectFilter || item.projectId === projectFilter))
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon-sm" className="relative" aria-label="任务中心" title="任务中心" />}>
        <ListTodo />
        {activeCount > 0 && <span className="absolute top-0 right-0 min-w-4 rounded bg-primary px-0.5 text-[10px] text-primary-foreground">{activeCount}</span>}
      </SheetTrigger>
      <SheetContent className="flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader className="border-b p-4">
          <SheetTitle>任务中心</SheetTitle>
        </SheetHeader>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div role="group" aria-label="任务状态" className="flex rounded-md border p-0.5">
            <Button size="sm" variant={filter === "active" ? "secondary" : "ghost"} aria-pressed={filter === "active"} onClick={() => setFilter("active")}>进行中 {activeCount}</Button>
            <Button size="sm" variant={filter === "all" ? "secondary" : "ghost"} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>最近任务</Button>
          </div>
          <select aria-label="筛选项目" className="h-8 min-w-24 flex-1 rounded-md border bg-background px-2 text-sm" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="">全部项目</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name || project.domain}</option>)}
          </select>
          <Button variant="ghost" size="icon-sm" title="刷新任务" aria-label="刷新任务" onClick={refresh}><RefreshCw /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {errors.length > 0 && <div role="status" className="border-b px-4 py-3 text-xs text-amber-700">
            {errors.map((item) => <p key={`${item.projectId}:${item.source}`} className="break-words">
              {projects.find((project) => project.id === item.projectId)?.name} · {taskSourceLabels[item.source]}：暂时无法更新{item.checkedAt ? `，上次读取 ${new Date(item.checkedAt).toLocaleTimeString()}` : ""}
            </p>)}
          </div>}
          {loading && <p role="status" className="p-4 text-sm text-muted-foreground">正在读取任务</p>}
          {!loading && visible.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">{errors.length ? "暂无可用任务记录" : "暂无符合条件的任务"}</p>}
          {visible.map(({ task, snapshot }) => {
            const active = isTaskActive(task)
            const Icon = /failed|rejected|blocked|unknown/i.test(task.status) ? AlertCircle : active ? Clock3 : CheckCircle2
            return <Link key={`${snapshot.projectId}:${task.kind}:${task.id}`} to={taskHref(snapshot.projectId, task)} onClick={() => setOpen(false)} className="flex gap-3 border-b px-4 py-3 hover:bg-muted/50">
              <Icon className="mt-1 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all text-sm font-medium">{task.title}</span>
                  <Badge variant="outline">{taskStatusLabel(task)}</Badge>
                </div>
                <p className="mt-1 break-words text-xs text-muted-foreground">{projects.find((project) => project.id === snapshot.projectId)?.name} · {task.kind === "agent" ? "Agent" : taskSourceLabels[snapshot.source]}</p>
                {taskReasonLabel(task) && <p className="mt-1 break-words text-xs text-muted-foreground">{taskReasonLabel(task)}</p>}
                {task.progress !== null && <div className="mt-2 flex items-center gap-2">
                  <progress aria-label={`${task.title}进度`} className="h-1.5 min-w-0 flex-1" max={100} value={task.progress} />
                  <span className="text-xs tabular-nums">{task.progress}%</span>
                </div>}
                {task.scheduled_at && active && <p className="mt-1 text-xs text-muted-foreground">计划处理：{new Date(task.scheduled_at).toLocaleString()}</p>}
                {snapshot.error && <p className="mt-1 text-xs text-amber-700">状态待更新</p>}
              </div>
            </Link>
          })}
          {snapshots.some((item) => item.has_more) && <p className="p-4 text-xs text-muted-foreground">仅显示最近一页记录，更多记录见对应业务页面。</p>}
        </div>
      </SheetContent>
    </Sheet>
  )
}
