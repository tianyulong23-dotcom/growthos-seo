import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  PerformanceBacklinkEvidence,
  PerformanceBacklinkEvents,
  PerformanceBacklinkPlacement,
  PerformanceBacklinkPlacementDetail,
  PerformanceBacklinksResponse,
} from "@/api/performance"
import { BacklinkMonitoringWorkspace } from "@/features/performance/backlinks/backlink-monitoring-workspace"

const performanceApi = vi.hoisted(() => ({
  getPerformanceBacklinkEvents: vi.fn(),
  getPerformanceBacklinkEvidence: vi.fn(),
  getPerformanceBacklinkPlacement: vi.fn(),
  getPerformanceBacklinks: vi.fn(),
  reverifyPerformanceBacklink: vi.fn(),
}))

vi.mock("@/api/performance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/performance")>()),
  ...performanceApi,
}))

const placement: PerformanceBacklinkPlacement = {
  recordType: "placement",
  displayState: "confirmed",
  placementId: "placement-1",
  candidateId: "candidate-1",
  opportunityId: "opportunity-1",
  replyId: "reply-1",
  lineageStatus: "OUTREACH_DERIVED",
  sourcePageUrl: "https://publisher.example/resources",
  targetUrl: "https://example.com/guide",
  initialValidationStatus: "VALID",
  healthStatus: "ACTIVE",
  monitoringState: "active",
  monitoringStatus: "completed",
  latestObservedAt: "2026-08-21T08:00:00Z",
  lastSuccessfulObservationAt: "2026-08-21T08:00:00Z",
  nextCheckAt: "2026-08-28T08:00:00Z",
  freshness: "fresh",
  latestFailure: { status: "none", code: null },
  evidenceSource: "DIRECT_MONITOR",
  version: 4,
  createdAt: "2026-08-01T08:00:00Z",
  countsTowardKpi: true,
}

function response(
  overrides: Partial<PerformanceBacklinksResponse> = {}
): PerformanceBacklinksResponse {
  return {
    items: [placement],
    nextCursor: null,
    hasMore: false,
    summary: {
      placements: {
        total: 1,
        pendingVerification: 0,
        active: 1,
        suspectedChanged: 0,
        changed: 0,
        suspectedLost: 0,
        lost: 0,
        recovered: 0,
      },
      candidates: { total: 2, countsTowardKpi: false },
      evidence: {
        source: "DIRECT_MONITOR",
        dataCutoff: "2026-08-21T08:00:00Z",
        freshness: "fresh",
        lastSuccessfulObservationAt: "2026-08-21T08:00:00Z",
        latestAttemptAt: "2026-08-21T08:00:00Z",
        latestAttemptStatus: "completed",
        latestFailure: { status: "none", code: null },
      },
    },
    meta: {
      organizationId: "org-1",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      requestId: "request-1",
      schemaVersion: "backlinks.v1",
      generatedAt: "2026-08-21T08:01:00Z",
    },
    ...overrides,
  }
}

const detail: PerformanceBacklinkPlacementDetail = {
  ...placement,
  normalizedSourceUrl: placement.sourcePageUrl,
  normalizedTargetUrl: placement.targetUrl,
  urlNormalizationVersion: "url-normalization-v1",
  updatedAt: "2026-08-21T08:00:00Z",
  initialValidation: {
    validationRunId: "validation-1",
    status: "VALID",
    evidenceSource: "DIRECT_VALIDATION",
    evidenceSnapshotHash: "validation-hash",
    evidenceContractVersion: "direct-validation-v1",
    evidenceSchemaVersion: 1,
  },
  consecutiveAnomalies: 0,
  browserFallbackEnabled: false,
  latestObservation: {
    observationId: "observation-1",
    result: "present",
    observedAt: "2026-08-21T08:00:00Z",
    executionMode: "static",
    evidenceSource: "DIRECT_MONITOR",
    evidence: {
      evidenceId: "evidence-1",
      hash: "monitor-hash",
      contractVersion: "direct-monitor-v1",
      schemaVersion: 1,
      freshness: "fresh",
    },
    failure: { status: "none", code: null },
  },
  lastSuccessfulObservation: {
    observationId: "observation-1",
    result: "present",
    observedAt: "2026-08-21T08:00:00Z",
    executionMode: "static",
    evidenceSource: "DIRECT_MONITOR",
    evidence: {
      evidenceId: "evidence-1",
      hash: "monitor-hash",
      contractVersion: "direct-monitor-v1",
      schemaVersion: 1,
      freshness: "fresh",
    },
    failure: { status: "none", code: null },
  },
  latestMonitorRun: {
    monitorRunId: "run-1",
    status: "completed",
    scheduledFor: "2026-08-21T08:00:00Z",
    updatedAt: "2026-08-21T08:00:00Z",
  },
}

const events: PerformanceBacklinkEvents = {
  items: [
    {
      eventId: "event-1",
      eventType: "placement.confirmed",
      occurredAt: "2026-08-01T08:00:00Z",
      placementVersion: 1,
      previousHealthStatus: null,
      nextHealthStatus: "ACTIVE",
      observationId: "observation-1",
      reason: "reply-confirmed",
    },
  ],
  nextCursor: null,
  hasMore: false,
  meta: response().meta,
}

const evidence: PerformanceBacklinkEvidence = {
  evidenceId: "evidence-1",
  placementId: "placement-1",
  kind: "placement_observation",
  evidenceSource: "DIRECT_MONITOR",
  immutable: true,
  hashVerified: true,
  hash: "monitor-hash",
  contractVersion: "direct-monitor-v1",
  schemaVersion: 1,
  observedAt: "2026-08-21T08:00:00Z",
  executionMode: "static",
  result: "present",
  reasonCode: null,
  failure: { status: "none", code: null },
  freshness: "fresh",
  source: {
    sourcePageUrl: placement.sourcePageUrl,
    targetUrl: placement.targetUrl,
    fetchMode: "static",
    httpStatus: 200,
    finalUrl: placement.sourcePageUrl,
    contentType: "text/html",
    fetchedAt: "2026-08-21T08:00:00Z",
    redirectChain: [],
    xRobotsTag: null,
  },
  link: {
    canonicalUrl: placement.sourcePageUrl,
    noindex: false,
    occurrenceCount: 1,
    robotsDirectives: [],
    occurrences: [
      {
        resolvedHref: placement.targetUrl,
        anchorText: "Guide",
        rel: [],
        nofollow: false,
        sponsored: false,
        ugc: false,
      },
    ],
  },
}

function renderWorkspace(projectId = "project-1") {
  return render(
    <MemoryRouter>
      <BacklinkMonitoringWorkspace projectId={projectId} />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  performanceApi.getPerformanceBacklinks.mockResolvedValue(response())
  performanceApi.getPerformanceBacklinkPlacement.mockResolvedValue(detail)
  performanceApi.getPerformanceBacklinkEvents.mockResolvedValue(events)
  performanceApi.getPerformanceBacklinkEvidence.mockResolvedValue(evidence)
  performanceApi.reverifyPerformanceBacklink.mockResolvedValue({
    placementId: "placement-1",
    placementVersion: 4,
    accepted: true,
    replayed: false,
    browserFallbackAllowed: false,
    monitorRun: {
      monitorRunId: "run-2",
      status: "scheduled",
      scheduledFor: "2026-08-22T08:00:00Z",
    },
    meta: response().meta,
  })
})

afterEach(cleanup)

describe("BacklinkMonitoringWorkspace", () => {
  it("renders project KPI from the Performance BFF without counting candidates", async () => {
    renderWorkspace()

    expect(await screen.findByText("项目级 Placement 成效")).toBeTruthy()
    expect(screen.getByText("计入外链成效 KPI")).toBeTruthy()
    expect(screen.getAllByText("不计入成效 KPI").length).toBeGreaterThan(0)
    expect(screen.getByText("DataForSEO")).toBeTruthy()
    expect(screen.getAllByText("Direct Monitor").length).toBeGreaterThan(0)
    expect(performanceApi.getPerformanceBacklinks).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        view: "placements",
        limit: 25,
        cursor: null,
        signal: expect.any(AbortSignal),
      })
    )
  })

  it("keeps historical facts visible when the latest provider attempt failed", async () => {
    performanceApi.getPerformanceBacklinks.mockResolvedValue(
      response({
        summary: {
          ...response().summary,
          evidence: {
            ...response().summary.evidence,
            latestAttemptStatus: "failed",
            latestFailure: { status: "failed", code: "provider_timeout" },
          },
        },
      })
    )

    renderWorkspace()

    expect(
      await screen.findByText("最近一次 Direct Monitor 尝试失败", {
        exact: false,
      })
    ).toBeTruthy()
    expect(
      screen.getAllByText(placement.sourcePageUrl).length
    ).toBeGreaterThan(0)
  })

  it("shows Placement and Candidate as separate states before first verification", async () => {
    performanceApi.getPerformanceBacklinks.mockResolvedValue(
      response({
        items: [],
        summary: {
          ...response().summary,
          placements: {
            ...response().summary.placements,
            active: 0,
            pendingVerification: 1,
          },
          evidence: {
            ...response().summary.evidence,
            dataCutoff: null,
            freshness: "unknown",
            lastSuccessfulObservationAt: null,
          },
        },
      })
    )

    renderWorkspace()

    expect(
      await screen.findByText("等待首次 Direct Monitor 验证")
    ).toBeTruthy()
    expect(
      screen.getByText("当前有 2 个 Candidate，但它们不会冒充已建立的外链成效。")
    ).toBeTruthy()
  })

  it("opens lineage, evidence, timeline and submits a versioned reverify command", async () => {
    renderWorkspace()

    fireEvent.click(
      (await screen.findAllByRole("button", {
        name: /查看 .* 监控详情/,
      }))[0]
    )

    expect(await screen.findByText("外链证据与时间线")).toBeTruthy()
    expect(screen.getByText("Placement 已确认")).toBeTruthy()
    expect(screen.getAllByText("opportunity-1").length).toBeGreaterThan(0)
    expect(screen.getAllByText("reply-1").length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("button", { name: "读取证据" }))
    expect(await screen.findByText("monitor-hash")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "重新验证" }))
    await waitFor(() => {
      expect(performanceApi.reverifyPerformanceBacklink).toHaveBeenCalledWith(
        "project-1",
        "placement-1",
        4,
        expect.any(String)
      )
    })
    expect(await screen.findByText("已受理，监控任务状态：scheduled")).toBeTruthy()
  })

  it("ignores an old project response after a project switch", async () => {
    let resolveProjectOne:
      | ((value: PerformanceBacklinksResponse) => void)
      | undefined
    const projectOneResponse = new Promise<PerformanceBacklinksResponse>(
      (resolve) => {
        resolveProjectOne = resolve
      }
    )
    performanceApi.getPerformanceBacklinks.mockImplementation(
      (projectId: string) => {
        if (projectId === "project-1") return projectOneResponse
        return Promise.resolve(
          response({
            items: [
              {
                ...placement,
                placementId: "placement-2",
                sourcePageUrl: "https://publisher-two.example/resources",
              },
            ],
            meta: {
              ...response().meta,
              websiteProjectId: "project-2",
            },
          })
        )
      }
    )

    const rendered = renderWorkspace("project-1")
    rendered.rerender(
      <MemoryRouter>
        <BacklinkMonitoringWorkspace projectId="project-2" />
      </MemoryRouter>
    )

    expect(
      (
        await screen.findAllByText(
          "https://publisher-two.example/resources"
        )
      ).length
    ).toBeGreaterThan(0)
    resolveProjectOne?.(response())
    await Promise.resolve()
    expect(screen.queryAllByText(placement.sourcePageUrl)).toHaveLength(0)
  })
})
