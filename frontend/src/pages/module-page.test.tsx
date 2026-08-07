import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuditRun } from "@/api/audits"
import { clearAuditSessionCache } from "@/features/audit/audit-session-cache"
import type { Project } from "@/features/projects/types"
import { ModulePage } from "@/pages/module-page"

const auditApi = vi.hoisted(() => ({
  createAuditRun: vi.fn(),
  getAuditRun: vi.fn(),
  listAuditRuns: vi.fn(),
}))

const projectApi = vi.hoisted(() => ({
  getProject: vi.fn(),
  refreshProject: vi.fn(),
  updateProject: vi.fn(),
  updateBusinessProfile: vi.fn(),
}))

vi.mock("@/api/audits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/audits")>()),
  ...auditApi,
}))

vi.mock("@/features/projects/project-context", () => ({
  useProjects: () => ({
    projects: [projectApi.getProject()],
    getProject: projectApi.getProject,
    refreshProject: projectApi.refreshProject,
    updateProject: projectApi.updateProject,
    updateBusinessProfile: projectApi.updateBusinessProfile,
  }),
}))

vi.mock("@/components/shared/page-header", () => ({
  PageHeader: () => null,
}))

vi.mock("@/features/audit/audit-workspace", () => ({
  AuditWorkspace: ({
    view,
    run,
    onRunChange,
  }: {
    view: string
    run: AuditRun | null
    onRunChange: (run: AuditRun | null) => void
  }) => (
    <div>
      <div data-testid="selected-view">{view}</div>
      <div data-testid="selected-run">{run?.run_id ?? "none"}</div>
      <button
        type="button"
        onClick={() =>
          onRunChange({
            ...run,
            run_id: "run-history",
            project_id: "project-1",
            status: "completed",
          } as AuditRun)
        }
      >
        select history
      </button>
    </div>
  ),
}))

const project: Project = {
  id: "project-1",
  name: "Example",
  domain: "example.com",
  country: "US",
  language: "en",
  competitorDomain: null,
  understandingRunId: null,
  understandingStatus: "completed",
  understandingStage: "completed",
  understandingMessage: "",
  understandingProgress: 100,
  understandingAttempt: 1,
  understandingStartedAt: null,
  understandingFinishedAt: null,
  understandingElapsedSeconds: 0,
  auditRunId: "run-latest",
  auditStatus: "completed",
  auditHealth: 90,
  siteProfile: null,
  createdAt: "2026-07-22",
}

const latestRun = {
  run_id: "run-latest",
  project_id: project.id,
  status: "completed",
  stage: "completed",
  message: "审计完成",
  progress: 100,
  discovered: 10,
  processed: 10,
  selected: 10,
  created_at: "2026-07-22T00:00:00Z",
  can_resume: false,
  summary: null,
  pagespeed: null,
} satisfies AuditRun

beforeEach(() => {
  vi.clearAllMocks()
  clearAuditSessionCache()
  projectApi.getProject.mockReturnValue(project)
  projectApi.refreshProject.mockResolvedValue(project)
  auditApi.getAuditRun.mockResolvedValue(latestRun)
  auditApi.listAuditRuns.mockImplementation(
    (_projectId: string, options?: { status?: string }) =>
      Promise.resolve({
        items: options?.status === "completed" ? [latestRun] : [latestRun],
        total: 1,
        page: 1,
        page_size: 1,
      })
  )
})

afterEach(() => {
  cleanup()
})

function tabIsDisabled(tab: HTMLElement) {
  return (
    tab.hasAttribute("disabled") || tab.getAttribute("aria-disabled") === "true"
  )
}

describe("ModulePage audit selection", () => {
  it("keeps only overview available before the first audit", async () => {
    projectApi.getProject.mockReturnValue({
      ...project,
      auditRunId: null,
      auditStatus: "never_started",
      auditHealth: null,
    })
    auditApi.listAuditRuns.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 1,
    })

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <Routes>
          <Route
            path="/projects/:projectId/:module/:view"
            element={<ModulePage />}
          />
        </Routes>
      </MemoryRouter>
    )

    expect(
      tabIsDisabled(await screen.findByRole("tab", { name: "概览" }))
    ).toBe(false)
    expect(tabIsDisabled(screen.getByRole("tab", { name: "内部资源" }))).toBe(
      true
    )
    expect(tabIsDisabled(screen.getByRole("tab", { name: "问题清单" }))).toBe(
      true
    )
    expect(tabIsDisabled(screen.getByRole("tab", { name: "审计历史" }))).toBe(
      true
    )
  })

  it("redirects a first-time project from a result URL to overview", async () => {
    const emptyRuns = {
      items: [] as AuditRun[],
      total: 0,
      page: 1,
      page_size: 1,
    }
    const resolveRequests: Array<(result: typeof emptyRuns) => void> = []
    projectApi.getProject.mockReturnValue({
      ...project,
      auditRunId: null,
      auditStatus: "never_started",
      auditHealth: null,
    })
    auditApi.listAuditRuns.mockImplementation(
      () =>
        new Promise<typeof emptyRuns>((resolve) => {
          resolveRequests.push(resolve)
        })
    )

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/issues"]}>
        <Routes>
          <Route
            path="/projects/:projectId/:module/:view"
            element={<ModulePage />}
          />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => expect(resolveRequests).toHaveLength(2))
    expect(screen.queryByTestId("selected-view")).toBeNull()

    await act(async () => {
      resolveRequests.forEach((resolve) => resolve(emptyRuns))
    })

    await waitFor(() => {
      expect(screen.getByTestId("selected-view").textContent).toBe("overview")
    })
  })

  it("keeps history disabled while the first audit is queued", async () => {
    const queuedRun = {
      ...latestRun,
      status: "queued" as const,
      stage: "queued",
      progress: 0,
    }
    projectApi.getProject.mockReturnValue({
      ...project,
      auditStatus: "queued",
      auditHealth: null,
    })
    auditApi.getAuditRun.mockResolvedValue(queuedRun)
    auditApi.listAuditRuns.mockImplementation(
      (_projectId: string, options?: { status?: string }) =>
        Promise.resolve({
          items: options?.status === "completed" ? [] : [queuedRun],
          total: options?.status === "completed" ? 0 : 1,
          page: 1,
          page_size: 1,
        })
    )

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <Routes>
          <Route
            path="/projects/:projectId/:module/:view"
            element={<ModulePage />}
          />
        </Routes>
      </MemoryRouter>
    )

    expect(
      tabIsDisabled(await screen.findByRole("tab", { name: "审计历史" }))
    ).toBe(true)
  })

  it("keeps result and history tabs available after a completed audit", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <Routes>
          <Route
            path="/projects/:projectId/:module/:view"
            element={<ModulePage />}
          />
        </Routes>
      </MemoryRouter>
    )

    expect(
      tabIsDisabled(await screen.findByRole("tab", { name: "内部资源" }))
    ).toBe(false)
    expect(tabIsDisabled(screen.getByRole("tab", { name: "PageSpeed" }))).toBe(
      false
    )
    expect(tabIsDisabled(screen.getByRole("tab", { name: "审计历史" }))).toBe(
      false
    )
  })

  it("restores a completed audit from cache without requesting its status again", async () => {
    const firstRender = render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <Routes>
          <Route
            path="/projects/:projectId/:module/:view"
            element={<ModulePage />}
          />
        </Routes>
      </MemoryRouter>
    )

    expect((await screen.findByTestId("selected-run")).textContent).toBe(
      "run-latest"
    )
    expect(auditApi.getAuditRun).toHaveBeenCalledTimes(1)
    firstRender.unmount()

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <Routes>
          <Route
            path="/projects/:projectId/:module/:view"
            element={<ModulePage />}
          />
        </Routes>
      </MemoryRouter>
    )

    expect(screen.getByTestId("selected-run").textContent).toBe("run-latest")
    expect(auditApi.getAuditRun).toHaveBeenCalledTimes(1)
  })

  it("restores a historical audit from the runId query parameter", async () => {
    const historicalRun = {
      ...latestRun,
      run_id: "run-history",
    }
    auditApi.getAuditRun.mockResolvedValue(historicalRun)

    render(
      <MemoryRouter
        initialEntries={[
          "/projects/project-1/audit/overview?runId=run-history",
        ]}
      >
        <Routes>
          <Route
            path="/projects/:projectId/:module/:view"
            element={<ModulePage />}
          />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(auditApi.getAuditRun).toHaveBeenCalledWith(
        "project-1",
        "run-history"
      )
      expect(screen.getByTestId("selected-run").textContent).toBe("run-history")
    })
  })

  it("does not let a pending latest-audit request replace a historical selection", async () => {
    let resolveLatestRun: ((run: AuditRun) => void) | undefined
    auditApi.getAuditRun.mockReturnValue(
      new Promise<AuditRun>((resolve) => {
        resolveLatestRun = resolve
      })
    )

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/history"]}>
        <Routes>
          <Route
            path="/projects/:projectId/:module/:view"
            element={<ModulePage />}
          />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(auditApi.getAuditRun).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(
      await screen.findByRole("button", { name: "select history" })
    )

    await waitFor(() => {
      expect(screen.getByTestId("selected-run").textContent).toBe("run-history")
    })

    await act(async () => {
      resolveLatestRun?.(latestRun)
      await Promise.resolve()
    })

    expect(screen.getByTestId("selected-run").textContent).toBe("run-history")
  })
})
