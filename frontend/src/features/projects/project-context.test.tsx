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
  const { projects, deleteProject, refreshProject } = useProjects()

  return (
    <>
      <span data-testid="domains">
        {projects.map((project) => project.domain).join(",")}
      </span>
      <button type="button" onClick={() => void refreshProject("project-1")}>
        Refresh
      </button>
      <button
        type="button"
        onClick={() => void deleteProject("project-1").catch(() => undefined)}
      >
        Delete
      </button>
    </>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  projectApi.listProjects.mockResolvedValue([queuedProject])
  projectApi.deleteProject.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe("ProjectProvider", () => {
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
})
