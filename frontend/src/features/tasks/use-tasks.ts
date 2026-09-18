import * as React from "react"

import { ApiError } from "@/api/client"
import { readTasks, taskSources, type TaskPage, type TaskSource } from "./task-api"

export type TaskSnapshot = TaskPage & {
  projectId: string
  source: TaskSource
  error: boolean
  checkedAt: string | null
}

export function useTasks(projectIds: string[], expanded: boolean) {
  const projectKey = JSON.stringify([...new Set(projectIds)].sort())
  const [snapshots, setSnapshots] = React.useState<Record<string, TaskSnapshot>>({})
  const [revision, refresh] = React.useReducer((value) => value + 1, 0)
  React.useEffect(() => {
    let active = true
    let timer = 0
    const controllers = new Set<AbortController>()
    const ids = JSON.parse(projectKey) as string[]
    const jobs = ids.flatMap((projectId) =>
      taskSources.map((source) => ({ projectId, source }))
    )
    async function poll() {
      let cursor = 0
      async function worker() {
        while (active && cursor < jobs.length) {
          const { projectId, source } = jobs[cursor++]
          const key = `${projectId}:${source}`
          const controller = new AbortController()
          controllers.add(controller)
          const timeout = window.setTimeout(() => controller.abort(), 8000)
          try {
            const page = await readTasks(projectId, source, controller.signal)
            if (active) setSnapshots((current) => ({
              ...current, [key]: {
                ...page, projectId, source, error: false, checkedAt: new Date().toISOString(),
              },
            }))
          } catch (error) {
            if (active) setSnapshots((current) => {
              const denied = error instanceof ApiError && [401, 403, 404, 409].includes(error.status)
              const previous = denied ? undefined : current[key]
              return { ...current, [key]: {
                items: previous?.items ?? [], has_more: previous?.has_more ?? false,
                projectId, source, error: true, checkedAt: previous?.checkedAt ?? null,
              } }
            })
          } finally {
            window.clearTimeout(timeout)
            controllers.delete(controller)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker))
      if (active) timer = window.setTimeout(() => void poll(), expanded ? 5000 : 30000)
    }
    void poll()
    return () => {
      active = false
      window.clearTimeout(timer)
      controllers.forEach((controller) => controller.abort())
    }
  }, [projectKey, expanded, revision])

  const visible = Object.values(snapshots).filter((item) => projectIds.includes(item.projectId))
  return {
    snapshots: visible,
    loading: visible.length < new Set(projectIds).size * taskSources.length,
    refresh,
  }
}
