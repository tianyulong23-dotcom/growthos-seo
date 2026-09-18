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

const { list, detail } = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }))
vi.mock("@/api/generated/backlinks", () => ({ requestBacklinks: list }))
vi.mock("@/features/outreach/drafts/api", () => ({ getDraft: detail }))

import { DraftInbox } from "./draft-inbox"

const item = (id = "d1") => ({
  id: `op-${id}`,
  draftId: id,
  targetHostAscii: `${id}.example.com`,
  contactEmail: "editor@example.com",
  primaryNextAction: { kind: "EDIT_DRAFT" },
})
const page = (
  items: unknown[] = [item()],
  nextCursor: string | null = null
) => ({
  items,
  nextCursor,
  hasMore: nextCursor !== null,
})
const draft = {
  id: "d1",
  status: "draft",
  freshness: { regenerateRequired: false },
  currentVersion: {
    subjectText: "Partnership proposal",
    bodyText: "Hello editor",
  },
}
const view = (project = "p1") => (
  <MemoryRouter>
    <DraftInbox websiteProjectKey={project} />
  </MemoryRouter>
)

beforeEach(() => {
  list.mockReset().mockResolvedValue(page())
  detail.mockReset().mockResolvedValue({ draft })
})
afterEach(cleanup)

describe("project draft inbox", () => {
  it("reads persisted drafts without Gmail and opens the existing editor", async () => {
    render(view())
    fireEvent.click(
      await screen.findByRole("button", { name: /d1.example.com/ })
    )
    expect(await screen.findByText("Partnership proposal")).toBeTruthy()
    expect(screen.getByText("Hello editor")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "打开草稿" }).getAttribute("href")
    ).toBe("/projects/p1/backlinks/drafts/d1")
    expect(detail).toHaveBeenCalledWith("p1", "d1", expect.any(AbortSignal))
    fireEvent.click(screen.getByRole("button", { name: /d1.example.com/ }))
    expect(screen.queryByText("正在读取正文…")).toBeNull()
    expect(
      list.mock.calls.every(
        ([operation]) => operation === "backlinksListOpportunitiesV1"
      )
    ).toBe(true)
  })

  it("continues beyond an empty opportunity page and deduplicates drafts", async () => {
    list
      .mockResolvedValueOnce(page([], "next"))
      .mockResolvedValueOnce(page([item(), item()]))
    render(view())
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }))
    await screen.findByRole("button", { name: /d1.example.com/ })
    expect(
      screen.getAllByRole("button", { name: /d1.example.com/ })
    ).toHaveLength(1)
    expect(list.mock.calls[1][1].query.cursor).toBe("next")
  })

  it("does not mix already-sent opportunities into pending drafts", async () => {
    list.mockResolvedValue(
      page([{ ...item(), primaryNextAction: { kind: "VIEW_MAIL_STATUS" } }])
    )
    render(view())
    expect(await screen.findByText("暂无待处理草稿")).toBeTruthy()
  })

  it("reports failures and permits a retry", async () => {
    list.mockRejectedValueOnce(new Error("403")).mockResolvedValueOnce(page())
    render(view())
    expect(await screen.findByRole("alert")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "重试" }))
    expect(
      await screen.findByRole("button", { name: /d1.example.com/ })
    ).toBeTruthy()
  })

  it("refreshes after an Agent creates a new draft", async () => {
    list.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page())
    render(view())
    await screen.findByText("暂无待处理草稿")
    fireEvent.click(screen.getByRole("button", { name: "刷新草稿" }))
    expect(
      await screen.findByRole("button", { name: /d1.example.com/ })
    ).toBeTruthy()
  })

  it("drops a late detail response when the project changes", async () => {
    let resolve!: (value: unknown) => void
    detail.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const rendered = render(view())
    fireEvent.click(
      await screen.findByRole("button", { name: /d1.example.com/ })
    )
    await waitFor(() => expect(detail).toHaveBeenCalledOnce())
    list.mockResolvedValue(page([]))
    rendered.rerender(view("p2"))
    await act(async () => {
      resolve({ draft })
    })
    expect(await screen.findByText("暂无待处理草稿")).toBeTruthy()
    expect(screen.queryByText("Partnership proposal")).toBeNull()
    expect(detail.mock.calls[0][2].aborted).toBe(true)
  })

  it("does not label a generating draft with no body as completed", async () => {
    detail.mockResolvedValue({
      draft: { ...draft, status: "generating", currentVersion: null },
    })
    render(view())
    fireEvent.click(
      await screen.findByRole("button", { name: /d1.example.com/ })
    )
    expect(await screen.findByText("生成中")).toBeTruthy()
    expect(screen.getByText("尚无可用正文")).toBeTruthy()
  })
})
