import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import type {
  ContentPlanItem,
  ContentPlanItemCollection,
  ContentPlanSettings,
} from "@/api/content-plan"
import { ContentPlan } from "@/features/content/content-plan"

const contentPlanApi = vi.hoisted(() => ({
  cancelContentPlanItem: vi.fn(),
  getContentPlanItem: vi.fn(),
  getContentPlanSettings: vi.fn(),
  listContentPlanItems: vi.fn(),
  updateContentPlanItem: vi.fn(),
  updateContentPlanSettings: vi.fn(),
}))

vi.mock("@/api/content-plan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/content-plan")>()),
  ...contentPlanApi,
}))

const summary = {
  id: "item-1",
  project_id: "project-1",
  source: "automatic",
  title: "test-title",
  primary_keyword: "test-keyword",
  edit_state: "idle",
  version: 4,
  publish_local_date: "2026-08-18",
  schedule_timezone: "Asia/Shanghai",
  generation_at: "2026-08-17T02:00:00Z",
  status: "scheduled",
  schedule_attention_reason: null,
  article_id: null,
  publication_status: null,
  review_status: null,
} satisfies ContentPlanItemCollection["items"][number]

const detail = {
  ...summary,
  seed_keyword: "test-seed",
  secondary_keywords: ["test-secondary"],
  keywords: [
    {
      keyword: "test-keyword",
      role: "primary",
      keyword_type: "informational",
      source: "related",
      position: 1,
    },
  ],
  writing_direction: "test-direction",
  title_source: "system",
  writing_direction_source: "system",
  title_user_edited: false,
  direction_user_edited: false,
  pending_preparation_id: null,
  preparation_version: 1,
  current_serp_snapshot_id: "serp-1",
  current_serp_snapshot: null,
  pending_preparation: null,
  review_version: null,
  publication_blocked_reason: null,
} satisfies ContentPlanItem

const settings = {
  cadence: "weekly_2_3",
  paused: false,
  timezone: "Asia/Shanghai",
  default_publish_local_time: "10:00:00",
  cadence_anchor_week: "2026-08-03",
  version: 3,
  updated_at: "2026-08-07T00:00:00Z",
} satisfies ContentPlanSettings

beforeEach(() => {
  vi.clearAllMocks()
  contentPlanApi.listContentPlanItems.mockResolvedValue({
    items: [summary],
    total: 1,
  })
  contentPlanApi.getContentPlanSettings.mockResolvedValue(settings)
  contentPlanApi.getContentPlanItem.mockResolvedValue(detail)
  contentPlanApi.updateContentPlanSettings.mockResolvedValue(settings)
})

afterEach(cleanup)

describe("ContentPlan", () => {
  it("shows only persisted plans and has no manual generation controls", async () => {
    render(<ContentPlan projectId="project-1" onOpenArticle={vi.fn()} />)

    expect(
      (await screen.findAllByText("test-title")).length
    ).toBeGreaterThan(0)
    expect(contentPlanApi.listContentPlanItems).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        startDate: expect.any(String),
        endDate: expect.any(String),
      })
    )
    expect(screen.queryByRole("button", { name: /自动生成 30 个/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /添加计划/ })).toBeNull()
  })

  it("renders an empty state instead of sample plans", async () => {
    contentPlanApi.listContentPlanItems.mockResolvedValue({
      items: [],
      total: 0,
    })

    render(<ContentPlan projectId="project-1" onOpenArticle={vi.fn()} />)

    fireEvent.click(await screen.findByRole("tab", { name: "列表" }))
    expect(await screen.findByText("本月没有匹配的计划")).toBeTruthy()
    expect(screen.queryByText("test-title")).toBeNull()
  })

  it("clears previously loaded plans when a later request fails", async () => {
    render(<ContentPlan projectId="project-1" onOpenArticle={vi.fn()} />)

    expect((await screen.findAllByText("test-title")).length).toBeGreaterThan(0)
    contentPlanApi.listContentPlanItems.mockRejectedValueOnce(
      new Error("test-request-failed")
    )

    fireEvent.click(screen.getByTitle("下个月"))

    await waitFor(() => {
      expect(screen.queryByText("test-title")).toBeNull()
    })
    expect(screen.getByText("test-request-failed")).toBeTruthy()
  })

  it("reads full detail separately and explains automatic article generation", async () => {
    render(<ContentPlan projectId="project-1" onOpenArticle={vi.fn()} />)

    fireEvent.click(
      await screen.findByLabelText("test-title，待生成")
    )

    await waitFor(() => {
      expect(contentPlanApi.getContentPlanItem).toHaveBeenCalledWith(
        "project-1",
        "item-1"
      )
    })
    expect(await screen.findByDisplayValue("test-seed")).toBeTruthy()
    expect(screen.getByText("文章会在计划时间自动生成。")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /立即生成文章/ })).toBeNull()
  })

  it("restores the persisted date when an edit is rejected", async () => {
    contentPlanApi.updateContentPlanItem.mockRejectedValue(
      new ApiError(409, "schedule_date_conflict", {
        code: "schedule_date_conflict",
        conflictId: "item-2",
      })
    )
    render(<ContentPlan projectId="project-1" onOpenArticle={vi.fn()} />)

    fireEvent.click(
      await screen.findByLabelText("test-title，待生成")
    )
    const dateInput = await screen.findByLabelText("目标上稿日期")
    fireEvent.change(dateInput, { target: { value: "2026-08-19" } })
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }))

    await waitFor(() => {
      expect(contentPlanApi.updateContentPlanItem).toHaveBeenCalledWith(
        "project-1",
        "item-1",
        expect.objectContaining({
          version: 4,
          publish_local_date: "2026-08-19",
        })
      )
      expect((dateInput as HTMLInputElement).value).toBe("2026-08-18")
    })
    expect(screen.getByText("该日期已有计划，请选择其他日期。")).toBeTruthy()
  })

  it("saves the real publishing settings with the current version", async () => {
    render(<ContentPlan projectId="project-1" onOpenArticle={vi.fn()} />)

    fireEvent.click(await screen.findByRole("button", { name: "发布频率" }))
    fireEvent.click(screen.getByRole("switch"))
    fireEvent.change(screen.getByPlaceholderText("Asia/Shanghai"), {
      target: { value: "America/New_York" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }))

    await waitFor(() => {
      expect(contentPlanApi.updateContentPlanSettings).toHaveBeenCalledWith(
        "project-1",
        {
          version: 3,
          cadence: "weekly_2_3",
          paused: true,
          timezone: "America/New_York",
        }
      )
    })
  })
})
