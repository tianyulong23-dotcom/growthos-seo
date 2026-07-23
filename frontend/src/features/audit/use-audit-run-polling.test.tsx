import * as React from "react"
import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AuditRun } from "@/api/audits"
import { useAuditRunPolling } from "@/features/audit/use-audit-run-polling"

const runningAudit = {
  project_id: "project",
  run_id: "run",
  status: "running",
  message: "正在抓取",
} as AuditRun

afterEach(() => {
  vi.useRealTimers()
})

describe("useAuditRunPolling", () => {
  it("keeps the current audit when a poll temporarily fails", async () => {
    vi.useFakeTimers()
    const onRunChange = vi.fn()
    const onError = vi.fn()
    const fetchRun = vi.fn().mockRejectedValue(new Error("network offline"))

    renderHook(() =>
      useAuditRunPolling({
        run: runningAudit,
        onRunChange,
        onError,
        onTerminal: vi.fn(),
        fetchRun,
        intervalMs: 10,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(fetchRun).toHaveBeenCalledWith("project", "run")
    expect(onError).toHaveBeenCalledWith("network offline")
    expect(onRunChange).not.toHaveBeenCalled()
  })

  it("publishes a completed audit and refreshes its project", async () => {
    vi.useFakeTimers()
    const completedAudit = {
      ...runningAudit,
      status: "completed",
      message: "审计完成",
    } as AuditRun
    const onRunChange = vi.fn()
    const onTerminal = vi.fn()

    renderHook(() =>
      useAuditRunPolling({
        run: runningAudit,
        onRunChange,
        onError: vi.fn(),
        onTerminal,
        fetchRun: vi.fn().mockResolvedValue(completedAudit),
        intervalMs: 10,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(onRunChange).toHaveBeenCalledWith(completedAudit)
    expect(onTerminal).toHaveBeenCalledWith("project")
  })

  it("refreshes the project after issue recalculation completes", async () => {
    vi.useFakeTimers()
    const recalculatingAudit = {
      ...runningAudit,
      status: "recalculating",
      stage: "recalculating_issues",
      message: "正在重新计算问题",
    } as AuditRun
    const completedAudit = {
      ...recalculatingAudit,
      status: "completed",
      stage: "completed",
      message: "问题已重新计算",
    } as AuditRun
    const onRunChange = vi.fn()
    const onTerminal = vi.fn()

    renderHook(() =>
      useAuditRunPolling({
        run: recalculatingAudit,
        onRunChange,
        onError: vi.fn(),
        onTerminal,
        fetchRun: vi.fn().mockResolvedValue(completedAudit),
        intervalMs: 10,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(onRunChange).toHaveBeenCalledWith(completedAudit)
    expect(onTerminal).toHaveBeenCalledWith("project")
  })

  it("ignores an in-flight poll after the selected audit changes", async () => {
    vi.useFakeTimers()
    let resolvePoll: ((run: AuditRun) => void) | undefined
    const fetchRun = vi.fn(
      () =>
        new Promise<AuditRun>((resolve) => {
          resolvePoll = resolve
        })
    )
    const onRunChange = vi.fn()
    const onError = vi.fn()
    const { rerender } = renderHook(
      ({ run }: { run: AuditRun | null }) =>
        useAuditRunPolling({
          run,
          onRunChange,
          onError,
          onTerminal: vi.fn(),
          fetchRun,
          intervalMs: 10,
        }),
      { initialProps: { run: runningAudit as AuditRun | null } }
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(fetchRun).toHaveBeenCalledOnce()

    rerender({
      run: {
        ...runningAudit,
        run_id: "run-history",
        status: "completed",
      },
    })

    await act(async () => {
      resolvePoll?.({
        ...runningAudit,
        status: "completed",
        message: "旧审计完成",
      })
      await Promise.resolve()
    })

    expect(onRunChange).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it("reports a terminal project refresh failure without rejecting", async () => {
    vi.useFakeTimers()
    const completedAudit = {
      ...runningAudit,
      status: "completed",
      message: "审计完成",
    } as AuditRun
    const onError = vi.fn()

    renderHook(() =>
      useAuditRunPolling({
        run: runningAudit,
        onRunChange: vi.fn(),
        onError,
        onTerminal: vi.fn().mockRejectedValue(new Error("refresh failed")),
        fetchRun: vi.fn().mockResolvedValue(completedAudit),
        intervalMs: 10,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(onError).toHaveBeenCalledWith(
      "审计状态已更新，但项目状态刷新失败：refresh failed"
    )
  })

  it("reports a terminal refresh failure after publishing terminal state", async () => {
    vi.useFakeTimers()
    const completedAudit = {
      ...runningAudit,
      status: "completed",
      message: "审计完成",
    } as AuditRun
    const onError = vi.fn()

    const { result } = renderHook(() => {
      const [run, setRun] = React.useState<AuditRun | null>(runningAudit)
      useAuditRunPolling({
        run,
        onRunChange: setRun,
        onError,
        onTerminal: vi.fn().mockRejectedValue(new Error("refresh failed")),
        fetchRun: vi.fn().mockResolvedValue(completedAudit),
        intervalMs: 10,
      })
      return run
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(result.current?.status).toBe("completed")
    expect(onError).toHaveBeenCalledWith(
      "审计状态已更新，但项目状态刷新失败：refresh failed"
    )
  })
})
