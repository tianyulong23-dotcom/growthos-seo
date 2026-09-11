import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  PerformanceBacklinkEvidence,
  PerformanceBacklinkEvents,
  PerformanceBacklinkPlacement,
  PerformanceBacklinkPlacementDetail,
  PerformanceBacklinksResponse,
} from "@/api/performance"
import type { BacklinksResponse } from "@/api/generated/backlinks"
import { BacklinkMonitoringWorkspace } from "@/features/performance/backlinks/backlink-monitoring-workspace"

const performanceApi = vi.hoisted(() => ({
  getPerformanceBacklinkEvents: vi.fn(),
  getPerformanceBacklinkEvidence: vi.fn(),
  getPerformanceBacklinkInventory: vi.fn(),
  getPerformanceBacklinkPlacement: vi.fn(),
  getPerformanceBacklinkProfile: vi.fn(),
  getPerformanceBacklinkProfileSyncJob: vi.fn(),
  getPerformanceBacklinks: vi.fn(),
  requestPerformanceBacklinkProfileSync: vi.fn(),
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

type InventoryResponse = BacklinksResponse<"backlinksListInventoryV1">
type ProfileResponse = BacklinksResponse<"backlinksGetProfileV1">
type ProfileSyncResponse = BacklinksResponse<"backlinksRequestProfileSyncV1">
type ProfileSyncJob = BacklinksResponse<"backlinksGetProfileSyncJobV1">["job"]

function inventoryResponse(
  projectId = "project-1",
  sourceUrl = "https://inventory-publisher.example/resources"
): InventoryResponse {
  return {
    items: [
      {
        inventoryItemId: "11111111-1111-4111-8111-111111111111",
        sourceType: "DATAFORSEO",
        provider: "dataforseo",
        sourceDomain: new URL(sourceUrl).hostname,
        sourceUrl,
        targetUrl: "https://example.com/guide",
        anchorText: "Project guide",
        relAttributes: [],
        providerStatus: "live",
        firstSeenAt: "2026-08-20T08:00:00Z",
        lastSeenAt: "2026-08-21T08:00:00Z",
        rank: 61,
        spamScore: 3,
        countryCode: "US",
        tld: "com",
        languageCode: "en",
        sourceHttpStatus: 200,
        targetHttpStatus: 200,
        redirectUrl: null,
        placementId: null,
        opportunityId: null,
        pinned: false,
        managed: false,
        directHealthStatus: "pending_verification",
        directValidationStatus: "UNVERIFIED",
        lastDirectCheckedAt: null,
        restrictionReason: null,
        userNotes: null,
        latestDirectEvidenceId: null,
        tier: "C",
        importance: "normal",
        monitoringStatus: "provider_only",
        policyVersion: "inventory-monitoring-v1",
        policyRevision: 1,
        nextCheckAt: null,
        providerOnlyReason: "provider_inventory_requires_pin_or_management",
      },
    ],
    page: 1,
    pageSize: 25,
    totalCount: 1,
    totalPages: 1,
    meta: {
      organizationId: "org-1",
      workspaceId: "workspace-1",
      websiteProjectId: projectId,
      requestId: "inventory-request-1",
      schemaVersion: "backlinks.v1",
      generatedAt: "2026-08-21T08:01:00Z",
    },
  }
}

function profileResponse(
  projectId = "project-1",
  canonicalDomain = "project-one.example",
  snapshot: ProfileResponse["snapshot"] = {
    snapshotId: "22222222-2222-4222-8222-222222222222",
    provider: "dataforseo",
    observedAt: "2026-08-21T08:00:00Z",
    freshUntil: "2026-08-28T08:00:00Z",
    freshness: "fresh",
    completeness: "full",
    totalBacklinks: 84,
    referringDomains: 38,
    dofollow: 61,
    nofollow: 23,
    sponsored: null,
    ugc: null,
    newBacklinks: 7,
    lostBacklinks: 6,
    inventoryPulledCount: 42,
    inventoryCoverage: 0.5,
    distributions: {},
    unavailableMetrics: ["sponsored", "ugc"],
    costMicros: 55_200,
    nextSyncAt: "2026-08-28T08:00:00Z",
  }
): ProfileResponse {
  return {
    canonicalDomain,
    snapshot,
    health: snapshot
      ? {
          score: 74,
          grade: "B",
          components: [],
          risks: [],
          positives: [],
          evidenceObservedAt: snapshot.observedAt,
          modelVersion: "backlink-profile-health.v1",
        }
      : null,
    sync: {
      providerEnabled: true,
      status: snapshot ? "completed" : "idle",
      lastSyncAt: snapshot?.observedAt ?? null,
      nextSyncAt: snapshot?.nextSyncAt ?? null,
      estimatedCostMicros: 55_200,
      actualCostMicros: snapshot?.costMicros ?? 0,
      stale: false,
      partial: false,
      providerInputRequired: false,
    },
    meta: {
      organizationId: "org-1",
      workspaceId: "workspace-1",
      websiteProjectId: projectId,
      requestId: "profile-request-1",
      schemaVersion: "backlinks.v1",
      generatedAt: "2026-08-21T08:01:00Z",
    },
  }
}

const profileSyncResponse: ProfileSyncResponse = {
  jobId: "33333333-3333-4333-8333-333333333333",
  workflowId: "backlink-profile-sync:test",
  status: "queued",
  canonicalDomain: "project-one.example",
  estimatedCostMicros: 55_200,
  providerInputRequired: false,
  replayed: false,
  meta: profileResponse().meta,
}

const completedProfileSyncJob: ProfileSyncJob = {
  jobId: profileSyncResponse.jobId,
  status: "completed",
  canonicalDomain: "project-one.example",
  totalCount: 84,
  pulledCount: 42,
  inventoryCoverage: 0.5,
  estimatedCostMicros: 55_200,
  actualCostMicros: 55_200,
  nextSyncAt: "2026-08-28T08:00:00Z",
  errorCode: null,
  startedAt: "2026-08-21T07:59:00Z",
  finishedAt: "2026-08-21T08:00:00Z",
  createdAt: "2026-08-21T07:59:00Z",
  updatedAt: "2026-08-21T08:00:00Z",
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
  performanceApi.getPerformanceBacklinkInventory.mockResolvedValue(
    inventoryResponse()
  )
  performanceApi.getPerformanceBacklinkProfile.mockResolvedValue(
    profileResponse()
  )
  performanceApi.requestPerformanceBacklinkProfileSync.mockResolvedValue(
    profileSyncResponse
  )
  performanceApi.getPerformanceBacklinkProfileSyncJob.mockResolvedValue(
    completedProfileSyncJob
  )
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

    expect(await screen.findByText("外链表现")).toBeTruthy()
    expect(screen.getByText("project-one.example")).toBeTruthy()
    expect(screen.getByText("84")).toBeTruthy()
    expect(screen.getByText("38")).toBeTruthy()
    expect(screen.getByText("净变化")).toBeTruthy()
    expect(screen.getByText("+1")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "已确认外链" })).toBeTruthy()
    expect(screen.getByText("全部外链")).toBeTruthy()
    expect(
      screen.getAllByText("inventory-publisher.example").length
    ).toBeGreaterThan(0)
    expect(screen.getByText("/resources")).toBeTruthy()
    expect(screen.getByText("数据口径")).toBeTruthy()
    expect(performanceApi.getPerformanceBacklinks).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        view: "placements",
        limit: 25,
        cursor: null,
        signal: expect.any(AbortSignal),
      })
    )
    expect(performanceApi.getPerformanceBacklinkInventory).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        page: 1,
        pageSize: 25,
        view: "all",
        signal: expect.any(AbortSignal),
      })
    )
    expect(performanceApi.getPerformanceBacklinkProfile).toHaveBeenCalledWith(
      "project-1",
      expect.any(AbortSignal)
    )
  })

  it("loads project-scoped inventory categories from the server", async () => {
    renderWorkspace()

    expect(await screen.findByText("全部外链")).toBeTruthy()
    performanceApi.getPerformanceBacklinkInventory.mockClear()

    fireEvent.click(screen.getByRole("button", { name: "查看引用域" }))
    expect(await screen.findByText("引用域明细")).toBeTruthy()
    await waitFor(() => {
      expect(
        performanceApi.getPerformanceBacklinkInventory
      ).toHaveBeenLastCalledWith(
        "project-1",
        expect.objectContaining({
          page: 1,
          view: "referring_domains",
          signal: expect.any(AbortSignal),
        })
      )
    })

    fireEvent.click(screen.getByRole("button", { name: "查看新增外链" }))
    expect(await screen.findByText("新增外链")).toBeTruthy()
    await waitFor(() => {
      expect(
        performanceApi.getPerformanceBacklinkInventory
      ).toHaveBeenLastCalledWith(
        "project-1",
        expect.objectContaining({
          page: 1,
          view: "new",
          signal: expect.any(AbortSignal),
        })
      )
    })

    fireEvent.click(screen.getByRole("button", { name: "查看丢失外链" }))
    expect(await screen.findByText("丢失外链")).toBeTruthy()
    await waitFor(() => {
      expect(
        performanceApi.getPerformanceBacklinkInventory
      ).toHaveBeenLastCalledWith(
        "project-1",
        expect.objectContaining({
          page: 1,
          view: "lost",
          signal: expect.any(AbortSignal),
        })
      )
    })

    fireEvent.click(screen.getByRole("button", { name: "查看全部外链" }))
    expect(await screen.findByText("全部外链")).toBeTruthy()
    await waitFor(() => {
      expect(
        performanceApi.getPerformanceBacklinkInventory
      ).toHaveBeenLastCalledWith(
        "project-1",
        expect.objectContaining({
          page: 1,
          view: "all",
          signal: expect.any(AbortSignal),
        })
      )
    })
  })

  it("uses a focused empty monitoring state instead of six equal zero metrics", async () => {
    performanceApi.getPerformanceBacklinks.mockResolvedValue(
      response({
        items: [],
        summary: {
          ...response().summary,
          placements: {
            total: 0,
            pendingVerification: 0,
            active: 0,
            suspectedChanged: 0,
            changed: 0,
            suspectedLost: 0,
            lost: 0,
            recovered: 0,
          },
        },
      })
    )

    renderWorkspace()

    expect(await screen.findByText("尚无已确认的外链成效")).toBeTruthy()
    expect(
      screen.getByText("已发现的外链仍会显示在下方，不会被隐藏。")
    ).toBeTruthy()
  })

  it("starts one durable initial profile sync and refreshes the project snapshot", async () => {
    performanceApi.getPerformanceBacklinkProfile
      .mockResolvedValueOnce(
        profileResponse("project-1", "project-one.example", null)
      )
      .mockResolvedValue(profileResponse())

    renderWorkspace()

    await waitFor(() => {
      expect(
        performanceApi.requestPerformanceBacklinkProfileSync
      ).toHaveBeenCalledWith(
        "project-1",
        "performance-backlinks-profile-initial-v1:project-1"
      )
    })
    expect(
      performanceApi.getPerformanceBacklinkProfileSyncJob
    ).toHaveBeenCalledWith(
      "project-1",
      profileSyncResponse.jobId,
      expect.any(AbortSignal)
    )
    expect(await screen.findByText("project-one.example")).toBeTruthy()
    expect(screen.getByText("84")).toBeTruthy()
    expect(
      performanceApi.requestPerformanceBacklinkProfileSync
    ).toHaveBeenCalledTimes(1)
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
    expect(screen.getAllByText(placement.sourcePageUrl).length).toBeGreaterThan(
      0
    )
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

    expect(await screen.findByText("等待首次 Direct Monitor 验证")).toBeTruthy()
    expect(
      screen.getByText(
        "当前有 2 个 Candidate，但它们不会冒充已建立的外链成效。"
      )
    ).toBeTruthy()
  })

  it("opens lineage, evidence, timeline and submits a versioned reverify command", async () => {
    renderWorkspace()

    fireEvent.click(
      (
        await screen.findAllByRole("button", {
          name: /查看 .* 监控详情/,
        })
      )[0]
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
    expect(
      await screen.findByText("已受理，监控任务状态：scheduled")
    ).toBeTruthy()
  })

  it("ignores an old project response after a project switch", async () => {
    let resolveProjectOne:
      ((value: PerformanceBacklinksResponse) => void) | undefined
    const projectOneResponse = new Promise<PerformanceBacklinksResponse>(
      (resolve) => {
        resolveProjectOne = resolve
      }
    )
    let resolveProjectOneInventory:
      ((value: InventoryResponse) => void) | undefined
    const projectOneInventoryResponse = new Promise<InventoryResponse>(
      (resolve) => {
        resolveProjectOneInventory = resolve
      }
    )
    let resolveProjectOneProfile: ((value: ProfileResponse) => void) | undefined
    const projectOneProfileResponse = new Promise<ProfileResponse>(
      (resolve) => {
        resolveProjectOneProfile = resolve
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
    performanceApi.getPerformanceBacklinkInventory.mockImplementation(
      (projectId: string) => {
        if (projectId === "project-1") return projectOneInventoryResponse
        return Promise.resolve(
          inventoryResponse(
            "project-2",
            "https://inventory-project-two.example/resources"
          )
        )
      }
    )
    performanceApi.getPerformanceBacklinkProfile.mockImplementation(
      (projectId: string) => {
        if (projectId === "project-1") return projectOneProfileResponse
        return Promise.resolve(
          profileResponse("project-2", "project-two.example")
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
      (await screen.findAllByText("https://publisher-two.example/resources"))
        .length
    ).toBeGreaterThan(0)
    expect(
      await screen.findByText("inventory-project-two.example")
    ).toBeTruthy()
    expect(screen.getByText("/resources")).toBeTruthy()
    expect(await screen.findByText("project-two.example")).toBeTruthy()
    expect(performanceApi.getPerformanceBacklinkInventory).toHaveBeenCalledWith(
      "project-2",
      expect.objectContaining({
        page: 1,
        view: "all",
        signal: expect.any(AbortSignal),
      })
    )
    resolveProjectOne?.(response())
    resolveProjectOneInventory?.(inventoryResponse())
    resolveProjectOneProfile?.(profileResponse())
    await Promise.resolve()
    expect(screen.queryAllByText(placement.sourcePageUrl)).toHaveLength(0)
    expect(screen.queryByText("inventory-publisher.example")).toBeNull()
    expect(screen.queryByText("project-one.example")).toBeNull()
  })
})
