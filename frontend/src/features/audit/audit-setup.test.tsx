import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AuditSetup } from "@/features/audit/audit-setup"
import { defaultAuditSettings } from "@/features/audit/audit-settings"
import type { Project } from "@/features/projects/types"

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
  auditRunId: null,
  auditStatus: "never_started",
  auditHealth: null,
  siteProfile: null,
  createdAt: "2026-08-05",
}

afterEach(cleanup)

describe("AuditSetup", () => {
  it("shows the recommended summary and opens the requested settings group", () => {
    render(<AuditSetup project={project} running={false} onStart={vi.fn()} />)

    expect(screen.getByDisplayValue("example.com")).toBeTruthy()
    expect(screen.getByText("推荐配置")).toBeTruthy()
    expect(screen.getByText("忽略 5 个参数")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "调整 URL 规则" }))

    expect(
      screen
        .getByRole("tab", { name: "URL 规则" })
        .getAttribute("aria-selected")
    ).toBe("true")
    expect(screen.getByText("允许抓取的目录")).toBeTruthy()
  })

  it("validates the page limit and submits the default audit settings", async () => {
    const onStart = vi.fn().mockResolvedValue(undefined)
    render(<AuditSetup project={project} running={false} onStart={onStart} />)

    const pageLimit = screen.getByRole("spinbutton", {
      name: "最大抓取页面",
    })
    const startButton = screen.getByRole("button", { name: "开始审计" })

    fireEvent.change(pageLimit, { target: { value: "0" } })
    expect(pageLimit.getAttribute("aria-invalid")).toBe("true")
    expect(startButton).toHaveProperty("disabled", true)

    fireEvent.change(pageLimit, { target: { value: "1000" } })
    fireEvent.click(startButton)

    await waitFor(() => {
      expect(onStart).toHaveBeenCalledWith(defaultAuditSettings)
    })
  })
})
