import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import { AutomationPanel } from "./automation-panel"
import type { Consent, Execution } from "./api"

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("@/api/client", async (original) => ({
  ...(await original<typeof import("@/api/client")>()),
  apiRequest: request,
}))

const consent: Consent = {
  id: "consent-a",
  state: "active",
  policy: {
    policy_version: "backlinks-drafts-only.v1",
    max_opportunities: 10,
    max_drafts: 5,
    max_model_cost_usd: "2",
    max_paid_tool_cost_usd: "0",
  },
  created_at: "2026-09-14T00:00:00Z",
  expires_at: "2099-01-01T00:00:00Z",
  sending_allowed: false,
  automation_enabled: false,
}
const execution: Execution = {
  run_id: "run-a",
  status: "completed",
  sending_allowed: false,
  checkpoint: {
    stage: "done",
    usage: { opportunities: 2, drafts: 2, model_usd: "1", paid_usd: "0" },
    results: [
      {
        feedItemId: "f1",
        opportunityId: "o1",
        draftId: "d1",
        state: "VERIFIED_DRAFT",
      },
      {
        feedItemId: "f2",
        opportunityId: "o2",
        state: "SKIPPED",
        reason: "NO_CONTACT",
      },
    ],
  },
}
let consents: Consent[]
let run: Execution | null
const posts = () =>
  request.mock.calls.filter(([, init]) => init?.method === "POST")
const view = (project = "p1") => (
  <MemoryRouter>
    <AutomationPanel websiteProjectKey={project} />
  </MemoryRouter>
)

beforeEach(() => {
  consents = []
  run = null
  request
    .mockReset()
    .mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        if (url.endsWith("/start")) {
          run = execution
          return execution
        }
        if (url.endsWith("/revoke")) {
          consents = [{ ...consent, state: "revoked" }]
          return consents[0]
        }
        consents = [consent]
        return consent
      }
      if (url.endsWith("/execution")) {
        if (!run) throw new ApiError(404, "BACKLINKS_AUTOMATION_NOT_FOUND")
        return run
      }
      return { items: consents }
    })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("Agent authorization and persisted progress", () => {
  it.each([null, execution])("renders campaign policies without legacy targets (run: %s)", async (savedRun) => {
    consents = [{
      ...consent,
      sending_allowed: true,
      policy: {
        policy_version: "backlinks-chat-campaign.v1",
        source_message_id: "message",
        max_opportunities: 10,
        max_drafts: 5,
        max_model_cost_usd: "2",
        max_paid_tool_cost_usd: "2",
        send_authorized: true,
        gmail_connection_id: "pinned-account",
      },
    }]
    run = savedRun
    const normal = request.getMockImplementation()!
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/send-batches") || url.endsWith("/draft-review")) return { items: [] }
      if (url.endsWith("/mail-monitoring")) return { items: [], connections: {}, partial: false, mail_unavailable: false }
      return normal(url, init)
    })
    render(view())
    await screen.findByText("自动外联批次 · 最多发送 5 封邮件")
    expect(screen.queryByRole("button", { name: "启动草稿流程" })).toBeNull()
    if (savedRun) {
      expect(screen.getByText("自动外联流程结束")).toBeTruthy()
      await screen.findByRole("region", { name: "批次发送" })
    }
    expect(posts()).toHaveLength(0)
  })

  it("shows a chat send batch without offering draft generation", async () => {
    consents = [{
      ...consent,
      policy: {
        policy_version: "backlinks-chat-send.v1",
        source_message_id: "message",
        targets: { gmail_connection_id: "account", items: [{ draft_id: "d1" }] },
      },
    }]
    const normal = request.getMockImplementation()!
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/send-batches") || url.endsWith("/draft-review")) {
        return { items: [] }
      }
      return normal(url, init)
    })
    render(view())
    await screen.findByText("聊天发送批次 · 1 封邮件")
    expect(screen.queryByRole("button", { name: "启动草稿流程" })).toBeNull()
    expect(screen.getByRole("checkbox", { name: "撤销授权并停止后续操作" })).toBeTruthy()
    expect(posts()).toHaveLength(0)
  })

  it("does not grant or start on mount and requires explicit confirmation", async () => {
    render(view())
    const button = await screen.findByRole<HTMLButtonElement>("button", {
      name: "确认草稿授权",
    })
    expect(button.disabled).toBe(true)
    expect(posts()).toHaveLength(0)
    fireEvent.click(screen.getByRole("checkbox", { name: /允许此项目/ }))
    fireEvent.click(button)
    await screen.findByRole("button", { name: "启动草稿流程" })
    expect(posts()).toHaveLength(1)
    const body = JSON.parse(posts()[0][1].body)
    expect(body.confirmed).toBe(true)
    expect(body.policy_version).toBe("backlinks-drafts-only.v1")
    expect(body).not.toHaveProperty("sending_allowed")
    expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now())
  })

  it.each([false, true])("retries the exact grant after a lost response (persisted: %s)", async (persisted) => {
    const normal = request.getMockImplementation()!
    let lost = true
    request.mockImplementation(async (...args) => {
      if (args[1]?.method === "POST" && lost) {
        lost = false
        if (persisted) await normal(...args)
        throw new Error("Response lost")
      }
      return normal(...args)
    })
    render(view())
    fireEvent.click(await screen.findByRole("checkbox", { name: /允许此项目/ }))
    fireEvent.click(screen.getByRole("button", { name: "确认草稿授权" }))
    const retry = await screen.findByRole("button", { name: "重试原授权请求" })
    await waitFor(() =>
      expect((retry as HTMLButtonElement).disabled).toBe(false)
    )
    expect(
      screen
        .getByRole("spinbutton", { name: "机会数量上限" })
        .closest("fieldset")?.disabled
    ).toBe(true)
    fireEvent.click(retry)
    await screen.findByRole("button", { name: "启动草稿流程" })
    expect(posts()[0][1].body).toBe(posts()[1][1].body)
  })

  it("retries the same start parameters after a lost response without automatic POST retry", async () => {
    consents = [consent]
    const normal = request.getMockImplementation()!
    let lost = true
    request.mockImplementation(async (...args) => {
      if (args[1]?.method === "POST" && lost) {
        lost = false
        throw new Error("Response lost")
      }
      return normal(...args)
    })
    render(view())
    await screen.findByRole("button", { name: "启动草稿流程" })
    fireEvent.change(screen.getByRole("textbox", { name: "推广目标 URL" }), {
      target: { value: "https://product.example.test/" },
    })
    fireEvent.click(screen.getByRole("checkbox", { name: "确认现在启动推荐至草稿流程" }))
    fireEvent.click(screen.getByRole("button", { name: "启动草稿流程" }))
    const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "重试原启动请求" })
    await waitFor(() => expect(retry.disabled).toBe(false))
    expect(posts()).toHaveLength(1)
    expect(screen.getByRole("textbox", { name: "推广目标 URL" }).closest("fieldset")?.disabled).toBe(true)
    fireEvent.click(retry)
    await screen.findByText("草稿流程结束")
    expect(posts()).toHaveLength(2)
    expect(posts()[0][1].body).toBe(posts()[1][1].body)
  })

  it("starts only on explicit confirmation using the selected persisted consent", async () => {
    consents = [consent]
    render(view())
    const button = await screen.findByRole<HTMLButtonElement>("button", {
      name: "启动草稿流程",
    })
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByRole("textbox", { name: "推广目标 URL" }), {
      target: { value: "https://product.example.test/" },
    })
    fireEvent.click(
      screen.getByRole("checkbox", { name: "确认现在启动推荐至草稿流程" })
    )
    fireEvent.click(button)
    await screen.findByText("草稿流程结束")
    expect(posts()).toHaveLength(1)
    expect(posts()[0][0]).toContain("/consent-a/start")
    expect(JSON.parse(posts()[0][1].body)).toEqual({
      confirmed: true,
      request: {
        promotionTargetUrl: "https://product.example.test/",
        language: "en",
      },
    })
  })

  it("reloads completed results and hands off to the existing approval/send page without writes", async () => {
    consents = [consent]
    run = execution
    const mounted = render(view())
    const link = await screen.findByRole("link", { name: "审批与发送" })
    expect(link.getAttribute("href")).toBe("/projects/p1/backlinks/drafts/d1")
    expect(screen.getByText(/保守预算预留，非实际扣费/)).toBeTruthy()
    expect(screen.getByText("已跳过")).toBeTruthy()
    mounted.unmount()
    render(view())
    await screen.findByText("草稿已核验")
    expect(posts()).toHaveLength(0)
    expect(screen.queryByRole("button", { name: "启动草稿流程" })).toBeNull()
  })

  it("polls only reads, reflects progress and stops on unmount", async () => {
    vi.useFakeTimers()
    consents = [consent]
    run = {
      ...execution,
      status: "running",
      checkpoint: { ...execution.checkpoint, stage: "job", results: [] },
    }
    const mounted = render(view())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText("等待草稿生成")).toBeTruthy()
    run = execution
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByText("草稿流程结束")).toBeTruthy()
    mounted.unmount()
    const count = request.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(request).toHaveBeenCalledTimes(count)
    expect(posts()).toHaveLength(0)
  })

  it("requires confirmation to revoke and disables further starts", async () => {
    consents = [consent]
    render(view())
    const button = await screen.findByRole<HTMLButtonElement>("button", {
      name: "撤销授权",
    })
    expect(button.disabled).toBe(true)
    fireEvent.click(
      screen.getByRole("checkbox", { name: "撤销授权并停止后续操作" })
    )
    fireEvent.click(button)
    await screen.findByText(/授权已撤销/)
    expect(posts()).toHaveLength(1)
    expect(posts()[0][0]).toContain("/consent-a/revoke")
    expect(screen.queryByRole("button", { name: "启动草稿流程" })).toBeNull()
  })

  it.each(["revoked", "expired"] as const)(
    "does not restart a %s consent",
    async (state) => {
      consents = [{ ...consent, state }]
      render(view())
      await screen.findByText(/后续操作已禁止/)
      expect(screen.queryByRole("button", { name: "启动草稿流程" })).toBeNull()
      expect(posts()).toHaveLength(0)
    }
  )

  it("does not treat a missing endpoint or denied request as no execution", async () => {
    consents = [consent]
    request.mockImplementation(async (url: string) => {
      if (url.endsWith("/execution")) throw new ApiError(404, "Not Found")
      return { items: consents }
    })
    render(view())
    await screen.findByRole("alert")
    expect(screen.queryByRole("button", { name: "启动草稿流程" })).toBeNull()
    expect(screen.queryByRole("button", { name: "确认草稿授权" })).toBeNull()
    expect(posts()).toHaveLength(0)
  })

  it("clears old project data and ignores its late response", async () => {
    consents = [consent]
    run = execution
    const mounted = render(view())
    await screen.findByRole("link", { name: "审批与发送" })
    let resolve!: (value: unknown) => void
    request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    fireEvent.click(screen.getByRole("button", { name: "刷新自动化" }))
    const old = resolve
    request.mockResolvedValue({ items: [] })
    mounted.rerender(view("p2"))
    await screen.findByRole("button", { name: "确认草稿授权" })
    await act(async () => {
      old({ items: [consent] })
    })
    expect(screen.queryByText("草稿已核验")).toBeNull()
    expect(screen.queryByRole("link", { name: "审批与发送" })).toBeNull()
    expect(posts()).toHaveLength(0)
  })
})
