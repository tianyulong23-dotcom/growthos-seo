import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import { backlinksProjectQueries } from "@/features/outreach/api/project-query"
import type { GmailStatusResponse } from "@/features/outreach/gmail/types"
import { useGmailConnection } from "@/features/outreach/gmail/use-gmail-connection"

const {
  getGmailConnectionStatus,
  selectGmailConnection,
  startGmailConnection,
} = vi.hoisted(() => ({
  getGmailConnectionStatus: vi.fn(),
  selectGmailConnection: vi.fn(),
  startGmailConnection: vi.fn(),
}))

vi.mock("@/features/outreach/gmail/api", () => ({
  disconnectGmailConnection: vi.fn(),
  getGmailConnectionStatus,
  selectGmailConnection,
  startGmailConnection,
}))

const statusResponse = (
  projectId: string,
  connectionId: string
): GmailStatusResponse => ({
  connection: {
    connectionId,
    version: 1,
    primaryEmail: `${connectionId}@example.test`,
    displayName: null,
    hostedDomain: null,
    grantedScopes: [],
    connectionStatus: "CONNECTED",
    sendAvailability: "AVAILABLE",
    mailSyncCapability: true,
    tokenExpiresAt: "2026-08-26T08:00:00.000Z",
    connectedAt: "2026-08-26T07:00:00.000Z",
    affectedProjectCount: 1,
    recentErrorCategory: null,
  },
  accounts: [],
  readiness: {
    evaluatedAt: "2026-08-26T07:00:00.000Z",
    connection: { state: "CONNECTED", ready: true },
    send: { state: "WAITING_FOR_SEND_CONTEXT", ready: false },
    sync: { state: "SYNC_READY", ready: true },
    blockers: [],
    primaryBlocker: null,
  },
  meta: {
    organizationId: "organization",
    workspaceId: "workspace",
    websiteProjectId: projectId,
    requestId: "request",
    schemaVersion: "backlinks.v1",
    generatedAt: "2026-08-26T07:00:00.000Z",
  },
})

afterEach(() => {
  backlinksProjectQueries.invalidate(["backlinks"])
  vi.clearAllMocks()
  vi.useRealTimers()
  window.history.replaceState({}, "", "/")
})

describe("useGmailConnection project ownership", () => {
  it("ignores an old project selection response after switching projects", async () => {
    let resolveProjectASelection:
      ((response: GmailStatusResponse) => void) | undefined
    const projectA = statusResponse("project-a-id", "gmail-a")
    const projectB = statusResponse("project-b-id", "gmail-b")

    getGmailConnectionStatus.mockImplementation((projectKey: string) =>
      Promise.resolve(projectKey === "project-a" ? projectA : projectB)
    )
    selectGmailConnection.mockImplementation(
      () =>
        new Promise<GmailStatusResponse>((resolve) => {
          resolveProjectASelection = resolve
        })
    )

    const { result, rerender } = renderHook(
      ({ projectKey }) => useGmailConnection(projectKey, true),
      { initialProps: { projectKey: "project-a" } }
    )

    await waitFor(() => {
      expect(result.current.connection?.connectionId).toBe("gmail-a")
    })

    let selection: Promise<void> | undefined
    act(() => {
      selection = result.current.select("gmail-a-replacement")
    })
    expect(selectGmailConnection).toHaveBeenCalledWith(
      "project-a",
      "gmail-a-replacement"
    )

    rerender({ projectKey: "project-b" })
    await waitFor(() => {
      expect(result.current.connection?.connectionId).toBe("gmail-b")
    })

    await act(async () => {
      resolveProjectASelection?.(
        statusResponse("project-a-id", "gmail-a-replacement")
      )
      await selection
    })

    expect(result.current.status).toBe("ready")
    expect(result.current.connection?.connectionId).toBe("gmail-b")
  })
})

describe("useGmailConnection OAuth start recovery", () => {
  it("refreshes a stale unavailable state after the backend restores the connection", async () => {
    vi.useFakeTimers()
    const unavailable = statusResponse("project-a-id", "gmail-a")
    unavailable.connection = {
      ...unavailable.connection!,
      connectionStatus: "REAUTH_REQUIRED",
      sendAvailability: "PAUSED",
      recentErrorCategory: "GOOGLE_AUTH_TEMPORARY_FAILURE",
    }
    unavailable.readiness = {
      ...unavailable.readiness,
      connection: { state: "NOT_CONNECTED", ready: false },
      send: { state: "BLOCKED", ready: false },
      sync: { state: "BLOCKED", ready: false },
    }
    getGmailConnectionStatus
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValue(statusResponse("project-a-id", "gmail-a"))

    const { result } = renderHook(() => useGmailConnection("project-a", true))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.readiness?.connection.ready).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })

    expect(getGmailConnectionStatus).toHaveBeenCalledTimes(2)
    expect(result.current.readiness?.connection.ready).toBe(true)
    expect(result.current.connection?.connectionStatus).toBe("CONNECTED")
  })

  it("restores an actionable message after a temporary Google callback failure", async () => {
    window.history.replaceState(
      {},
      "",
      "/projects/project-a/backlinks/email?gmailOAuth=provider_unavailable"
    )
    getGmailConnectionStatus.mockResolvedValue(
      statusResponse("project-a-id", "gmail-a")
    )

    const { result } = renderHook(() => useGmailConnection("project-a", true))

    await waitFor(() => {
      expect(result.current.status).toBe("ready")
    })
    expect(result.current.errorMessage).toBe(
      "Google 授权服务暂时不可用，连接未完成。请点击重新连接 Gmail；系统不会误标为已连接。"
    )
    expect(window.location.search).toBe("")
  })

  it("does not loop on the same canonical origin and clears the busy state", async () => {
    getGmailConnectionStatus.mockResolvedValue(
      statusResponse("project-a-id", "gmail-a")
    )
    startGmailConnection.mockRejectedValue(
      new ApiError(409, "OAuth origin mismatch", {
        code: "OAUTH_ORIGIN_MISMATCH",
        retryable: true,
        canonicalFrontendOrigin: window.location.origin,
      })
    )

    const { result } = renderHook(() => useGmailConnection("project-a", true))

    await waitFor(() => {
      expect(result.current.status).toBe("ready")
    })

    await act(async () => {
      await result.current.connect()
    })

    expect(result.current.busyAction).toBeNull()
    expect(result.current.errorMessage).toBe(
      "Gmail 授权地址配置不一致，系统未创建授权票据。请刷新后重试。"
    )
  })
})
