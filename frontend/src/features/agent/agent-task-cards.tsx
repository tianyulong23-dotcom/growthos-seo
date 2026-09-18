import * as React from "react"
import { ArrowUpRight, RefreshCw } from "lucide-react"
import { Link } from "react-router"

import { apiRequest, ApiError } from "@/api/client"
import { requestBacklinks } from "@/api/generated/backlinks"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  isTaskActive, readTasks, taskHref, taskReasonLabel, taskStatusLabel, type TaskItem,
} from "@/features/tasks/task-api"

export function AgentTaskCards({ projectId, references }: {
  projectId: string
  references: unknown
}) {
  if (!Array.isArray(references)) return null
  return <div className="my-2 space-y-2">
    {Array.from(new Map(references.filter(isReference).map((task) =>
      [`${task.kind}:${task.task_id}`, task])).values()).slice(-10).map((task) =>
      <TaskCard key={`${projectId}:${task.kind}:${task.task_id}`} projectId={projectId} reference={task} />
    )}
  </div>
}

type TaskReference = Pick<TaskItem, "kind" | "title" | "status" | "related_id"> & { task_id: string }
function isReference(value: unknown): value is TaskReference {
  if (!value || typeof value !== "object") return false
  const task = value as Partial<TaskReference>
  return typeof task.task_id === "string" && typeof task.title === "string" &&
    typeof task.status === "string" && typeof task.kind === "string" &&
    ["article", "content_plan", "audit", "project", "keywords", "agent",
      "performance", "onboarding", "recommendation", "draft"].includes(task.kind)
}

async function readReference(projectId: string, reference: TaskReference, signal: AbortSignal): Promise<TaskItem> {
  if (reference.kind === "draft") {
    const { job } = await requestBacklinks("backlinksGetDraftJobV1", {
      path: { websiteProjectKey: projectId, jobId: reference.task_id },
    }, { signal })
    return { ...reference, id: job.id, status: job.status, related_id: job.draftId,
      progress: null, stage: null, updated_at: null }
  }
  if (reference.kind === "recommendation") {
    const page = await readTasks(projectId, "recommendation", signal)
    const task = page.items.find((item) => item.id === reference.task_id)
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND")
    return task
  }
  return apiRequest(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${reference.kind}/${encodeURIComponent(reference.task_id)}`, { signal })
}

function TaskCard({ projectId, reference }: { projectId: string; reference: TaskReference }) {
  const [task, setTask] = React.useState<TaskItem>({
    ...reference, id: reference.task_id, progress: null, stage: null, updated_at: null,
  })
  const [state, setState] = React.useState<"receipt" | "live" | "stale" | "denied">("receipt")
  const [revision, refresh] = React.useReducer((value) => value + 1, 0)
  // A receipt contains identity only; progress always comes from the owning module.
  const key = JSON.stringify(reference)
  React.useEffect(() => {
    const selected = JSON.parse(key) as TaskReference
    let active = true
    let timer = 0
    let request: AbortController | undefined
    async function poll() {
      let keepPolling = true
      request = new AbortController()
      const timeout = window.setTimeout(() => request?.abort(), 8000)
      try {
        const next = await readReference(projectId, selected, request.signal)
        keepPolling = isTaskActive(next)
        if (active) { setTask(next); setState("live") }
      } catch (error) {
        if (active) setState(error instanceof ApiError && [401, 403, 404].includes(error.status) ? "denied" : "stale")
      } finally {
        window.clearTimeout(timeout)
        if (active && keepPolling) timer = window.setTimeout(() => void poll(), 10000)
      }
    }
    void poll()
    return () => { active = false; request?.abort(); window.clearTimeout(timer) }
  }, [projectId, key, revision])
  return <div className="rounded-md border px-3 py-2">
    <div className="flex items-start gap-2">
      <Link className="min-w-0 flex-1 break-words font-medium" to={taskHref(projectId, task)}>{reference.title}<ArrowUpRight className="ml-1 inline size-3" /></Link>
      <Button size="icon-xs" variant="ghost" aria-label="刷新任务状态" title="刷新任务状态" onClick={refresh}><RefreshCw /></Button>
    </div>
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      <Badge variant="outline">{state === "denied" ? "任务不可访问" : taskStatusLabel(task)}</Badge>
      {state === "receipt" && <span>提交时状态</span>}
      {state === "stale" && <span role="status">状态待更新</span>}
      {state === "live" && task.progress !== null && <span>{task.progress}%</span>}
    </div>
    {state === "live" && taskReasonLabel(task) && <p className="mt-1 break-words text-xs text-muted-foreground">{taskReasonLabel(task)}</p>}
  </div>
}
