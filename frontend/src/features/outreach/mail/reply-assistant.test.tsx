import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ getReplyContext: vi.fn(), generateReply: vi.fn(), sendReply: vi.fn() }))
vi.mock("./reply-assistant-api", () => api)
import { ReplyAssistant } from "./reply-assistant"

const context = {
  recipient: "bruno@publisher.test", subject: "Re: Cooperation",
  gmailConnectionId: "account", message: { id: "inbound", version: 3, matchedOpportunityId: "opportunity" },
  existingReply: null,
}
const proposal = {
  summary: "对方报价 R$ 500，尚未确认链接属性。", key_points: ["R$ 500 / 篇"],
  questions: ["是否接受报价？"], warnings: [], body: "Olá, poderiam esclarecer os atributos do link?",
  expectedVersion: 3, generationToken: null,
}
const view = (message = "inbound", account = "account") =>
  <ReplyAssistant websiteProjectKey="project" messageId={message} connectionId={account} />
async function loaded() { await screen.findByText("bruno@publisher.test") }
async function consent() {
  fireEvent.click(screen.getByRole("checkbox", { name: "本次生成后直接发送" }))
  expect(api.sendReply).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole("button", { name: "同意，仅本次" }))
}
beforeEach(() => {
  api.getReplyContext.mockReset().mockResolvedValue(context)
  api.generateReply.mockReset().mockResolvedValue(proposal)
  api.sendReply.mockReset().mockResolvedValue({ id: "intent", status: "QUEUED" })
})
afterEach(cleanup)

describe("mail reply assistant", () => {
  it("does not call AI or send on open; generates editable text and sends to the actual inbound sender", async () => {
    render(view()); await loaded()
    expect(api.generateReply).not.toHaveBeenCalled()
    expect(api.sendReply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText("商量价格"))
    fireEvent.change(screen.getByLabelText("补充想法"), { target: { value: "Ask for a lower price." } })
    fireEvent.change(screen.getByLabelText("邮件语言"), { target: { value: "pt" } })
    fireEvent.click(screen.getByRole("button", { name: "生成回复" }))
    await screen.findByText(proposal.summary)
    expect(api.generateReply.mock.calls[0][2]).toMatchObject({
      action: "draft", stance: "negotiate", reply_language: "pt", authorize_one_reply: false,
    })
    expect(api.sendReply).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("回复正文"), { target: { value: "Obrigado. Podemos negociar?" } })
    fireEvent.click(screen.getByRole("button", { name: "发送回复" }))
    await screen.findByText(/回复已提交发送队列/)
    expect(api.sendReply).toHaveBeenCalledTimes(1)
    expect(api.sendReply.mock.calls[0][2]).toMatchObject({
      recipient: "bruno@publisher.test", expectedVersion: 3,
      body: "Obrigado. Podemos negociar?", confirmed: true, confirmationMode: "MANUAL",
    })
  })

  it("requires explicit one-reply consent and sends only once", async () => {
    api.generateReply.mockResolvedValue({ ...proposal, generationToken: "signed" })
    render(view()); await loaded(); await consent()
    const button = screen.getByRole("button", { name: "生成并发送本次回复" })
    fireEvent.click(button); fireEvent.click(button)
    await screen.findByText(/回复已提交发送队列/)
    expect(api.generateReply).toHaveBeenCalledTimes(1)
    expect(api.sendReply).toHaveBeenCalledTimes(1)
    expect(api.sendReply.mock.calls[0][2]).toMatchObject({ confirmationMode: "ONE_REPLY", generationToken: "signed" })
  })

  it("stops automatic sending on warnings even if a token is returned", async () => {
    api.generateReply.mockResolvedValue({ ...proposal, warnings: ["付款条款待核对"], generationToken: "signed" })
    render(view()); await loaded(); await consent()
    fireEvent.click(screen.getByRole("button", { name: "生成并发送本次回复" }))
    await screen.findByText("付款条款待核对")
    expect(api.sendReply).not.toHaveBeenCalled()
    expect(await screen.findByText("本次草稿需要人工检查，未自动发送。")).toBeTruthy()
  })

  it("ignores a late AI response after changing messages and resets consent", async () => {
    let finish!: (value: unknown) => void
    api.generateReply.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const rendered = render(view()); await loaded(); await consent()
    fireEvent.click(screen.getByRole("button", { name: "生成并发送本次回复" }))
    rendered.rerender(view("other"))
    await loaded()
    await act(async () => finish({ ...proposal, generationToken: "signed" }))
    expect(api.sendReply).not.toHaveBeenCalled()
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText("回复正文") as HTMLTextAreaElement).value).toBe("")
  })

  it("retains edits on a failed send and guards duplicate clicks", async () => {
    api.sendReply.mockRejectedValue(new Error("MAIL_REPLY_CONTEXT_CHANGED"))
    render(view()); await loaded()
    fireEvent.change(screen.getByLabelText("回复正文"), { target: { value: "My own reply" } })
    const button = screen.getByRole("button", { name: "发送回复" })
    fireEvent.click(button); fireEvent.click(button)
    await screen.findByRole("alert")
    expect(api.sendReply).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText("回复正文") as HTMLTextAreaElement).value).toBe("My own reply")
  })

  it("blocks sending with another Gmail account", async () => {
    render(view("inbound", "another")); await loaded()
    fireEvent.change(screen.getByLabelText("回复正文"), { target: { value: "Reply" } })
    expect((screen.getByRole("button", { name: "发送回复" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("reconciles a persisted reply after an interrupted send instead of allowing a new body", async () => {
    api.sendReply.mockRejectedValueOnce(new Error("Request interrupted"))
    api.getReplyContext.mockResolvedValueOnce(context).mockResolvedValue({
      ...context, existingReply: { draftId: "draft", body: "Persisted reply", sendIntentId: "intent" },
    })
    render(view()); await loaded()
    fireEvent.change(screen.getByLabelText("回复正文"), { target: { value: "Persisted reply" } })
    fireEvent.click(screen.getByRole("button", { name: "发送回复" }))
    await screen.findByRole("alert")
    expect(api.getReplyContext).toHaveBeenCalledTimes(2)
    expect((screen.getByLabelText("回复正文") as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "发送回复" }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.sendReply).toHaveBeenCalledTimes(1)
  })

  it("retries the already saved body if preflight failed, but locks an existing send intent", async () => {
    api.getReplyContext.mockResolvedValue({
      ...context, existingReply: { draftId: "draft", body: "Saved reply", sendIntentId: null },
    })
    const rendered = render(view()); await loaded()
    expect((screen.getByLabelText("回复正文") as HTMLTextAreaElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "发送回复" }))
    await waitFor(() => expect(api.sendReply).toHaveBeenCalledTimes(1))
    expect(api.sendReply.mock.calls[0][2].body).toBe("Saved reply")
    api.getReplyContext.mockResolvedValue({
      ...context, existingReply: { draftId: "draft", body: "Saved reply", sendIntentId: "intent" },
    })
    rendered.rerender(view("other")); await loaded()
    await waitFor(() => expect((screen.getByRole("button", { name: "发送回复" }) as HTMLButtonElement).disabled).toBe(true))
  })

  it("can retry reading context after an unavailable backend", async () => {
    api.getReplyContext.mockRejectedValueOnce(new Error("503"))
    render(view())
    fireEvent.click(await screen.findByRole("button", { name: "重新读取回件" }))
    await loaded()
    expect(api.getReplyContext).toHaveBeenCalledTimes(2)
  })
})
