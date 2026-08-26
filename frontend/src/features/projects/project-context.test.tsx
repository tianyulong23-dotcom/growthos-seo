import * as React from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ProjectProvider,
  useProjects,
} from "@/features/projects/project-context"
import type { Project } from "@/features/projects/types"

const projectApi = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getProject: vi.fn(),
  createProject: vi.fn(),
  archiveProject: vi.fn(),
  restoreProject: vi.fn(),
  deleteProject: vi.fn(),
  refreshBusinessProfile: vi.fn(),
  updateBusinessProfile: vi.fn(),
}))

vi.mock("@/api/projects", () => projectApi)

const queuedProject: Project = {
  id: "project-1",
  name: "Example",
  domain: "example.com",
  country: "US",
  language: "en",
  competitorDomain: null,
  understandingRunId: "understanding-run-1",
  understandingStatus: "queued",
  understandingStage: "queued",
  understandingMessage: "Queued",
  understandingProgress: 0,
  understandingAttempt: 1,
  understandingStartedAt: null,
  understandingFinishedAt: null,
  understandingElapsedSeconds: 0,
  auditRunId: null,
  auditStatus: "never_started",
  auditHealth: null,
  siteProfile: null,
  createdAt: "2026-08-03",
}

function ProjectStateProbe() {
  const {
    projects,
    archivedProjects,
    loadState,
    archiveProject,
    restoreProject,
    deleteProject,
    getProject,
    refreshProject,
  } = useProjects()
  const [error, setError] = React.useState("")

  return (
    <>
      <span data-testid="load-state">{loadState}</span>
      <span data-testid="domains">
        {projects.map((project) => project.domain).join(",")}
      </span>
      <span data-testid="understanding-statuses">
        {projects.map((project) => project.understandingStatus).join(",")}
      </span>
      <span data-testid="archived-domains">
        {archivedProjects.map((project) => project.domain).join(",")}
      </span>
      <span data-testid="missing-project-id">
        {getProject("missing-project").id}
      </span>
      <span data-testid="error">{error}</span>
      <button
        type="button"
        onClick={() =>
          void refreshProject("project-1").catch((refreshError: unknown) => {
            setError(
              refreshError instanceof Error
                ? refreshError.message
                : "Refresh failed"
            )
          })
        }
      >
        Refresh
      </button>
      <button
        type="button"
        onClick={() => void deleteProject("project-1").catch(() => undefined)}
      >
        Delete
      </button>
      <button
        type="button"
        onClick={() => void archiveProject("project-1").catch(() => undefined)}
      >
        Archive
      </button>
      <button
        type="button"
        onClick={() => void restoreProject("project-1").catch(() => undefined)}
      >
        Restore
      </button>
    </>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  projectApi.listProjects.mockResolvedValue([queuedProject])
  projectApi.archiveProject.mockResolvedValue({
    ...queuedProject,
    lifecycleStatus: "ARCHIVED",
    lifecycleVersion: 2,
    archivedAt: "2026-08-15T01:00:00.000Z",
    archiveReason: "USER_REQUESTED",
    contextVersion: 2,
  })
  projectApi.restoreProject.mockResolvedValue({
    ...queuedProject,
    lifecycleStatus: "ACTIVE",
    lifecycleVersion: 3,
    archivedAt: null,
    archiveReason: null,
    contextVersion: 3,
  })
  projectApi.deleteProject.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("ProjectProvider", () => {
  it("resolves only the exact requested project", async () => {
    render(
      <ProjectProvider>
        <ProjectStateProbe />
      </ProjectProvider>
    )

    expect(await screen.findByText("example.com")).toBeTruthy()
    expect(screen.getByTestId("load-state").textContent).toBe("ready")
    expect(screen.getByTestId("missing-project-id").textContent).toBe("")
  })

  it("rejects a refresh response for another project", async () => {
    projectApi.getProject.mockResolvedValue({
      ...queuedProject,
      id: "project-2",
      domain: "other.example",
    })

    render(
      <ProjectProvider>
        <ProjectStateProbe />
      </ProjectProvider>
    )

    expect(await screen.findByText("example.com")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain(
        "does not match"
      )
    })
    expect(screen.getByTestId("domains").textContent).toBe("example.com")
  })

  it("moves archived projects out of the active collection and restores them", async () => {
    render(
      <ProjectProvider>
        <ProjectStateProbe />
      </ProjectProvider>
    )

    expect(await screen.findByText("example.com")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Archive" }))

    await waitFor(() => {
      expect(screen.getByTestId("domains").textContent).toBe("")
      expect(screen.getByTestId("archived-domains").textContent).toBe(
        "example.com"
      )
    })

    fireEvent.click(screen.getByRole("button", { name: "Restore" }))

    await waitFor(() => {
      expect(screen.getByTestId("domains").textContent).toBe("example.com")
      expect(screen.getByTestId("archived-domains").textContent).toBe("")
    })
  })

  it("does not restore a deleted project from a late list response", async () => {
    let resolveList!: (projects: Project[]) => void
    projectApi.listProjects.mockReturnValue(
      new Promise<Project[]>((resolve) => {
        resolveList = resolve
      })
    )

    render(
      <ProjectProvider>
        <ProjectStateProbe />
      </ProjectProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() => {
      expect(projectApi.deleteProject).toHaveBeenCalledWith("project-1")
    })

    await act(async () => {
      resolveList([queuedProject])
    })

    expect(screen.getByTestId("domains").textContent).toBe("")
    expect(screen.getByTestId("load-state").textContent).toBe("ready")
  })

  it("does not restore a deleted project when an older refresh finishes", async () => {
    let resolveRefresh!: (project: Project) => void
    projectApi.getProject.mockReturnValue(
      new Promise<Project>((resolve) => {
        resolveRefresh = resolve
      })
    )

    render(
      <ProjectProvider>
        <ProjectStateProbe />
      </ProjectProvider>
    )

    expect(await screen.findByText("example.com")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => {
      expect(projectApi.getProject).toHaveBeenCalledWith("project-1")
    })

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() => {
      expect(screen.getByTestId("domains").textContent).toBe("")
    })

    await act(async () => {
      resolveRefresh(queuedProject)
    })

    expect(screen.getByTestId("domains").textContent).toBe("")
  })

  it("ignores an in-flight stale poll and does not trigger a business refresh", async () => {
    vi.useFakeTimers()
    let resolvePoll!: (project: Project) => void
    projectApi.getProject
      .mockReturnValueOnce(
        new Promise<Project>((resolve) => {
          resolvePoll = resolve
        })
      )
      .mockResolvedValueOnce({
        ...queuedProject,
        understandingStatus: "completed",
        understandingStage: "completed",
        understandingMessage: "Completed",
        understandingProgress: 100,
      })

    render(
      <ProjectProvider>
        <ProjectStateProbe />
      </ProjectProvider>
    )

    await act(async () => undefined)
    expect(screen.getByTestId("domains").textContent).toBe("example.com")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(projectApi.getProject).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await act(async () => undefined)
    expect(screen.getByTestId("understanding-statuses").textContent).toBe(
      "completed"
    )

    await act(async () => {
      resolvePoll(queuedProject)
    })

    expect(screen.getByTestId("understanding-statuses").textContent).toBe(
      "completed"
    )
    expect(projectApi.refreshBusinessProfile).not.toHaveBeenCalled()
  })
})
