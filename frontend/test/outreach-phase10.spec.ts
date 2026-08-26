import { expect, test } from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

const {
  inboundMessageId,
  opportunityId,
  placementId,
  projectKey,
  reconciliationSendIntentId,
  replyCandidateId,
} = outreachFixture

test("mail center exposes persisted reconciliation state without send or sync side effects", async ({
  page,
}) => {
  const session = await installOutreachApiFixtures(page)

  await page.goto(`/projects/${projectKey}/backlinks/email`)
  const queue = page.getByLabel("发送与对账队列")
  await expect(
    queue.getByRole("heading", { name: "发送与对账队列" })
  ).toBeVisible()
  await expect(queue.getByText("发送结果未知", { exact: true })).toBeVisible()

  const reconciliationItem = queue.getByRole("button", {
    name: /finance@publisher\.example\.test/,
  })
  await expect(
    reconciliationItem.getByText("需对账", { exact: true })
  ).toBeVisible()
  await reconciliationItem.click()
  await expect(
    queue.getByText("先核对 Gmail 结果，禁止自动重发", { exact: true })
  ).toBeVisible()
  await expect(
    queue.locator("dd").getByText("owner@example.test", { exact: true })
  ).toBeVisible()
  await expect(
    queue.locator("dd").getByText("outreach@example.test", { exact: true })
  ).toBeVisible()
  await expect(
    queue
      .locator("dd")
      .getByText("finance@publisher.example.test", { exact: true })
  ).toBeVisible()

  expect(
    session.capturedRequests.some(
      (request) =>
        request.method === "GET" &&
        request.pathname ===
          `/api/v1/projects/${projectKey}/backlinks/send-intents`
    )
  ).toBe(true)
  expect(
    session.capturedRequests.some(
      (request) =>
        request.method === "GET" &&
        request.pathname ===
          `/api/v1/projects/${projectKey}/backlinks/send-intents/${reconciliationSendIntentId}`
    )
  ).toBe(true)
  expect(
    session.capturedRequests.filter(
      (request) =>
        request.method !== "GET" &&
        (request.pathname.includes("/send-intents") ||
          request.pathname.endsWith("/sync"))
    )
  ).toEqual([])
  expect(session.unexpectedNetwork).toEqual([])
})

test("phase 10 preserves reply attribution through negotiation, placement, and reports", async ({
  page,
}) => {
  const session = await installOutreachApiFixtures(page)

  await page.goto(`/projects/${projectKey}/backlinks/email`)
  await page.getByText("Re: E2E collaboration", { exact: true }).click()
  await page.getByRole("radio").check()
  await page
    .getByPlaceholder("记录人工核对依据")
    .fill("Confirmed against the Phase 10 local fixture.")
  await page.getByRole("button", { name: "确认关联" }).click()

  await expect(page.getByRole("heading", { name: "协商事实" })).toBeVisible()
  await expect(page.getByText("ZAR 7,500", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "确认", exact: true }).click()
  await page.getByLabel("处理原因").fill("Verified against the inbound reply.")
  await page.getByRole("button", { name: "提交处理" }).click()
  await expect(page.getByText("已追加事实版本 v2。")).toBeVisible()
  await expect(page.getByText("v2", { exact: true })).toBeVisible()

  const placementUrl = new URLSearchParams({
    opportunityId,
    replyId: inboundMessageId,
    placementId,
    returnTo: `/projects/${projectKey}/backlinks/email`,
  })
  await page.goto(
    `/projects/${projectKey}/backlinks/links?${placementUrl.toString()}`
  )

  await expect(
    page.getByRole("heading", { name: "Placement 链接详情" })
  ).toBeVisible()
  await expect(page.getByText("外联归因 Placement")).toBeVisible()
  await expect(
    page
      .getByRole("link", {
        name: "https://publisher.example.test/article",
        exact: true,
      })
      .first()
  ).toBeVisible()
  await expect(
    page.getByText(`Reply：${inboundMessageId}`, { exact: true })
  ).toBeVisible()

  await page.getByRole("link", { name: "查看项目报告" }).click()
  await expect(page).toHaveURL(
    new RegExp(
      `/projects/${projectKey}/backlinks/reports\\?.*opportunityId=${opportunityId}.*replyId=${inboundMessageId}.*placementId=${placementId}`
    )
  )
  await expect(
    page.getByRole("heading", { name: "外链事实指标" })
  ).toBeVisible()
  await expect(page.getByText("Active Placement")).toBeVisible()
  await expect(page.getByText("Africa/Johannesburg")).toBeVisible()
  await page.getByRole("link", { name: "返回来源" }).click()
  await expect(page).toHaveURL(
    new RegExp(
      `/projects/${projectKey}/backlinks/links\\?opportunityId=${opportunityId}&replyId=${inboundMessageId}&placementId=${placementId}$`
    )
  )

  const matchRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith(`/match-candidates/${replyCandidateId}/confirm`)
  )
  expect(matchRequest?.body).toEqual({
    expectedMatchStatus: "CANDIDATES_READY",
    reason: "Confirmed against the Phase 10 local fixture.",
  })

  const negotiationRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith("/negotiation-facts/decisions")
  )
  expect(negotiationRequest?.body).toEqual({
    sourceFactVersionId: "negotiation-fact-e2e-v1",
    expectedFactVersion: 1,
    decision: "CONFIRM",
    reason: "Verified against the inbound reply.",
  })
  expect(negotiationRequest?.idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  )
  expect(session.unexpectedNetwork).toEqual([])
})
