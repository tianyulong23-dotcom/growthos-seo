import { expect, test } from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

const {
  projectKey,
  opportunityId,
  contactId,
  draftId,
  draftVersionId,
  sendIntentId,
  replyCandidateId,
} = outreachFixture

test("desktop outreach path composes from an opportunity, sends, syncs a reply, and shows placement", async ({
  page,
}, testInfo) => {
  const session = await installOutreachApiFixtures(page)

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  await expect(
    page.getByRole("heading", { name: "外链", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "publisher.example.test", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("高适合度 · 综合适合度 92.0", { exact: true })
  ).toBeVisible()

  await page.getByRole("tab", { name: "外链机会" }).click()
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/backlinks/opportunities$`)
  )
  await expect(
    page.getByText("publisher.example.test", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "详情" }).click()
  await expect(
    page.getByRole("heading", { name: "publisher.example.test" })
  ).toBeVisible()
  await page.getByRole("link", { name: "撰写邮件" }).click()
  await expect(page).toHaveURL(
    new RegExp(
      `/projects/${projectKey}/backlinks/drafts/new\\?opportunityId=${opportunityId}$`
    )
  )
  await expect(
    page.getByRole("heading", { name: "生成邮件草稿" })
  ).toBeVisible()
  await expect(page.getByText("editor@publisher.example.test")).toBeVisible()
  await expect(page.getByLabel("机会 ID")).toHaveCount(0)
  await page.getByRole("button", { name: "生成草稿" }).click()
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/backlinks/drafts/${draftId}$`)
  )
  await expect(page.getByLabel("邮件主题")).toHaveValue(
    "E2E collaboration proposal"
  )

  await page.getByRole("button", { name: "人工批准" }).click()
  await expect(page.getByText("当前草稿版本已人工批准。")).toBeVisible()
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "最终确认并发送" }).click()
  await expect(page.getByText("Gmail Provider 已接受")).toBeVisible()
  await expect(page.getByText("gmail-message-e2e")).toBeVisible()

  await page.goto(`/projects/${projectKey}/backlinks/email`)
  await expect(page.getByTestId("mail-sync-diagnostics")).toBeHidden()
  await expect(page.getByText("owner@example.test").first()).toBeVisible()
  await page.getByText("Re: E2E collaboration", { exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "回信人工确认" })
  ).toBeVisible()
  await page.getByRole("radio").check()
  await page
    .getByPlaceholder("记录人工核对依据")
    .fill("Confirmed against the local E2E opportunity fixture.")
  await page.getByRole("button", { name: "确认关联" }).click()
  await expect(page.getByText("已关联到外链机会")).toBeVisible()

  await page.goto(`/projects/${projectKey}/performance/links`)
  await expect(page.getByRole("heading", { name: "效果" })).toBeVisible()
  await page.getByRole("tab", { name: "Confirmed" }).click()
  await expect(
    page.getByText("https://publisher.example.test/article")
  ).toBeVisible()
  await page.getByRole("button", { name: "查看 confirmed 链接详情" }).click()
  await expect(
    page.getByRole("heading", { name: "Placement 链接详情" })
  ).toBeVisible()
  await expect(page.getByText("present · static")).toBeVisible()
  await expect(page.getByText("placement.confirmed")).toBeVisible()

  const screenshot = await page.screenshot({
    path: testInfo.outputPath("bl-ai-190-desktop.png"),
    fullPage: true,
  })
  await testInfo.attach("bl-ai-190-desktop", {
    body: screenshot,
    contentType: "image/png",
  })

  const sendRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith(`/drafts/${draftId}/send-intents`)
  )
  const preflightRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith(`/drafts/${draftId}/send-preflight`)
  )
  expect(preflightRequest?.body).toEqual({
    approvedDraftVersionId: draftVersionId,
    contactId,
    contactVersion: 1,
    gmailConnectionId: "gmail-connection-e2e",
    messagePurpose: "INITIAL_OUTREACH",
    followUpIndex: 0,
  })
  expect(sendRequest?.idempotencyKey).toBeTruthy()
  expect(sendRequest?.body).toEqual({
    approvedDraftVersionId: draftVersionId,
    contactId,
    contactVersion: 1,
    gmailConnectionId: "gmail-connection-e2e",
    messagePurpose: "INITIAL_OUTREACH",
    followUpIndex: 0,
    readinessSnapshot: expect.objectContaining({
      schemaVersion: "gmail-send-readiness.v1",
      policyVersion: "gmail-send-policy.v1",
      snapshotVersion:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    humanConfirmation: {
      confirmed: true,
      confirmedAt: expect.any(String),
      readinessSnapshotVersion:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  })

  const replyMatchRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith(`/match-candidates/${replyCandidateId}/confirm`)
  )
  expect(replyMatchRequest?.body).toEqual({
    expectedMatchStatus: "CANDIDATES_READY",
    reason: "Confirmed against the local E2E opportunity fixture.",
  })
  expect(session.unexpectedNetwork).toEqual([])
})

test("phase 9 persists readiness confirmation before accepted send and exposes synced mail", async ({
  page,
}) => {
  const session = await installOutreachApiFixtures(page)

  await page.goto(`/projects/${projectKey}/backlinks/drafts/${draftId}`)
  await expect(page.getByLabel("邮件主题")).toHaveValue(
    "E2E collaboration proposal"
  )

  await page.getByRole("button", { name: "人工批准" }).click()
  await expect(page.getByText("当前草稿版本已人工批准。")).toBeVisible()
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "最终确认并发送" }).click()

  await expect(page.getByText("Gmail Provider 已接受")).toBeVisible()
  await expect(page.getByText("gmail-message-e2e")).toBeVisible()
  await expect
    .poll(
      () =>
        session.capturedRequests.filter(
          (request) =>
            request.method === "GET" &&
            request.pathname.endsWith(`/send-intents/${sendIntentId}`)
        ).length
    )
    .toBeGreaterThanOrEqual(2)

  const preflightRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith(`/drafts/${draftId}/send-preflight`)
  )
  const sendRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith(`/drafts/${draftId}/send-intents`)
  )

  expect(preflightRequest?.body).toEqual({
    approvedDraftVersionId: draftVersionId,
    contactId,
    contactVersion: 1,
    gmailConnectionId: "gmail-connection-e2e",
    messagePurpose: "INITIAL_OUTREACH",
    followUpIndex: 0,
  })
  expect(sendRequest?.idempotencyKey).toBeTruthy()
  expect(sendRequest?.body).toEqual({
    approvedDraftVersionId: draftVersionId,
    contactId,
    contactVersion: 1,
    gmailConnectionId: "gmail-connection-e2e",
    messagePurpose: "INITIAL_OUTREACH",
    followUpIndex: 0,
    readinessSnapshot: expect.objectContaining({
      schemaVersion: "gmail-send-readiness.v1",
      policyVersion: "gmail-send-policy.v1",
      snapshotVersion:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    humanConfirmation: {
      confirmed: true,
      confirmedAt: expect.any(String),
      readinessSnapshotVersion:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  })

  await page.goto(`/projects/${projectKey}/backlinks/email`)
  await expect(
    page.getByText("Re: E2E collaboration", { exact: true })
  ).toBeVisible()
})

test("recommendation generation reconnects one server batch across navigation and refresh", async ({
  page,
}) => {
  test.setTimeout(45_000)
  const session = await installOutreachApiFixtures(page, {
    recommendationMode: "generate",
    recommendationCompleteAfterReads: 6,
  })

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  await expect
    .poll(
      () =>
        session.capturedRequests.filter(
          (request) =>
            request.method === "POST" &&
            request.pathname.endsWith("/recommendation-refill-jobs")
        ).length
    )
    .toBe(1)
  await expect(
    page.getByText(/推荐任务已排队|正在计算网站适合度|正在处理联系人/)
  ).toBeVisible()

  await page.getByRole("tab", { name: "外链机会" }).click()
  await page.getByRole("tab", { name: "推荐池" }).click()
  await expect(page.getByText("前台等待已结束")).toHaveCount(0)

  await expect(
    page.getByRole("link", {
      name: "publisher.example.test",
      exact: true,
    })
  ).toBeVisible({ timeout: 20_000 })
  await page.reload()
  await expect(
    page.getByRole("link", {
      name: "publisher.example.test",
      exact: true,
    })
  ).toBeVisible()
  const currentPoolMetric = page
    .getByText("本轮推荐", { exact: true })
    .locator("..")
  await expect(currentPoolMetric.getByText("20", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "归档本轮" })).toBeEnabled()
  await expect(
    page.getByRole("button", { name: "归档并生成下一轮" })
  ).toBeEnabled()
  const firstRecommendation = page.locator("article").filter({
    has: page.getByRole("link", {
      name: "publisher.example.test",
      exact: true,
    }),
  })
  await expect(
    firstRecommendation.getByText("高适合度 · 综合适合度 92.0", {
      exact: true,
    })
  ).toBeVisible()
  await expect(firstRecommendation.getByText("产品：E2E product")).toBeVisible()
  await expect(
    firstRecommendation.getByText("12,500", { exact: true })
  ).toBeVisible()
  await expect(
    firstRecommendation.getByRole("link", { name: "相关内容页" })
  ).toBeVisible()
  await expect(
    firstRecommendation.getByText("查看公开证据 · visible_text")
  ).toBeVisible()

  const refillRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith("/recommendation-refill-jobs")
  )
  expect(refillRequests).toHaveLength(1)
  expect(refillRequests[0]?.idempotencyKey).toBeUndefined()
  expect(refillRequests[0]?.body).toMatchObject({
    expectedVersion: 0,
    recommendationContextVersionId: "018f0000-0000-7000-8000-000000000401",
    visiblePoolGeneration: 1,
    lowWatermark: 20,
    highWatermark: 40,
  })
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem(
        "growthos:recommendation-refill:e2e-project:018f0000-0000-7000-8000-000000000401:g1"
      )
    )
  ).toBe("018f0000-0000-7000-8000-000000000402")
  expect(session.unexpectedNetwork).toEqual([])
})

test("recommendation pool waits after archive and only builds the next fixed generation on user request", async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000)
  const session = await installOutreachApiFixtures(page, {
    recommendationMode: "ready",
    recommendationPoolSize: 20,
    recommendationCompleteAfterReads: 3,
  })

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  const currentPoolMetric = page
    .getByText("本轮推荐", { exact: true })
    .locator("..")
  await expect(currentPoolMetric.getByText("20", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "加入 Opportunity" }).first().click()
  await expect(
    page.getByRole("status").filter({ hasText: "你仍在推荐池中" })
  ).toContainText("publisher.example.test 已加入 Opportunity")
  await expect(
    page.getByRole("link", { name: "publisher.example.test", exact: true })
  ).toBeVisible()
  expect(
    session.capturedRequests.filter(
      (request) =>
        request.method === "POST" &&
        request.pathname.endsWith("/recommendation-refill-jobs")
    )
  ).toHaveLength(0)

  await page.getByRole("button", { name: "归档本轮" }).click()
  await expect(page.getByText("当前推荐轮次已归档")).toBeVisible()
  await expect(page.getByRole("button", { name: "生成下一轮" })).toBeVisible()
  const archiveRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith("/recommendation-pools/1/archive")
  )
  expect(archiveRequests).toHaveLength(1)
  expect(archiveRequests[0]?.idempotencyKey).toBe(
    "recommendation-pool-archive:018f0000-0000-7000-8000-000000000401:g1"
  )
  expect(archiveRequests[0]?.body).toEqual({
    recommendationContextVersionId: "018f0000-0000-7000-8000-000000000401",
  })
  expect(
    session.capturedRequests.filter(
      (request) =>
        request.method === "POST" &&
        request.pathname.endsWith("/recommendation-refill-jobs")
    )
  ).toHaveLength(0)

  await page.getByRole("button", { name: "生成下一轮" }).click()
  await expect
    .poll(
      () =>
        session.capturedRequests.filter(
          (request) =>
            request.method === "POST" &&
            request.pathname.endsWith("/recommendation-refill-jobs")
        ).length
    )
    .toBe(1)
  const refillRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith("/recommendation-refill-jobs")
  )
  expect(refillRequest?.body).toMatchObject({
    recommendationContextVersionId: "018f0000-0000-7000-8000-000000000401",
    visiblePoolGeneration: 2,
    lowWatermark: 20,
    highWatermark: 40,
  })
  await expect(
    page.getByRole("link", {
      name: "publisher-g2-01.example.test",
      exact: true,
    })
  ).toBeVisible({ timeout: 15_000 })
  await expect(currentPoolMetric.getByText("20", { exact: true })).toBeVisible()
  const archivedMetric = page
    .getByText("历史已归档", { exact: true })
    .locator("..")
  await expect(archivedMetric.getByText("20", { exact: true })).toBeVisible()
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem(
        "growthos:recommendation-refill:e2e-project:018f0000-0000-7000-8000-000000000401:g2"
      )
    )
  ).toBe("018f0000-0000-7000-8000-000000000412")

  const screenshot = await page.screenshot({
    path: testInfo.outputPath("fixed-recommendation-pool-generation-2.png"),
    fullPage: true,
  })
  await testInfo.attach("fixed-recommendation-pool-generation-2", {
    body: screenshot,
    contentType: "image/png",
  })
  expect(session.unexpectedNetwork).toEqual([])
})

test("a new project reuses an organization Gmail account without OAuth", async ({
  page,
}) => {
  const session = await installOutreachApiFixtures(page, {
    gmailMode: "reusable",
  })

  await page.goto(`/projects/${projectKey}/backlinks/email`)
  await expect(page.getByText("选择组织已有 Gmail 账号")).toBeVisible()

  await page.getByLabel("当前项目发件账号").click()
  await page.getByRole("option", { name: /owner@example\.test/ }).click()

  await expect(page.getByText("owner@example.test").first()).toBeVisible()
  await expect
    .poll(
      () =>
        session.capturedRequests.filter(
          (request) =>
            request.method === "POST" &&
            request.pathname.endsWith("/gmail-connections/select")
        ).length
    )
    .toBe(1)

  const selectRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith("/gmail-connections/select")
  )
  expect(selectRequest?.body).toEqual({
    connectionId: "gmail-connection-e2e",
  })
  expect(
    session.capturedRequests.some(
      (request) =>
        request.method === "POST" &&
        request.pathname.endsWith("/gmail-connections/connect")
    )
  ).toBe(false)
  expect(session.unexpectedNetwork).toEqual([])
})

test("internal mail and draft diagnostics stay hidden", async ({ page }) => {
  await installOutreachApiFixtures(page, {
    draftJobStatuses: ["RUNNING", "RUNNING", "RUNNING"],
  })

  await page.goto(`/projects/${projectKey}/backlinks/email`)
  await expect(page.getByTestId("mail-sync-diagnostics")).toBeHidden()
  await expect(
    page.getByRole("button", { name: "立即同步并刷新邮件" })
  ).toBeVisible()

  await page.goto(
    `/projects/${projectKey}/backlinks/drafts/new?opportunityId=${opportunityId}`
  )
  await page.getByRole("button", { name: "生成草稿" }).click()
  await expect(page.getByTestId("draft-job-diagnostics")).toBeHidden()
  await expect(page.getByRole("button", { name: "正在等待后端" })).toBeVisible()
})

test("Backlink Profile exposes stale partial inventory with filters and pagination", async ({
  page,
}) => {
  const session = await installOutreachApiFixtures(page)

  await page.goto(`/projects/${projectKey}/performance/links`)
  await expect(
    page.getByRole("heading", { name: "Backlink Profile" })
  ).toBeVisible()
  await expect(
    page.getByText("Provider required", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("Stale", { exact: true })).toBeVisible()
  await expect(page.getByText("Partial", { exact: true })).toBeVisible()
  await expect(page.getByText("50%", { exact: true })).toBeVisible()
  await expect(
    page.getByText("source-1.publisher.example.test", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("Direct VALID", { exact: true })).toBeVisible()
  await expect(page.getByText("Tier A", { exact: true }).first()).toBeVisible()

  await page
    .getByRole("button", {
      name: "查看历史 source-1.publisher.example.test",
    })
    .click()
  await expect(page.getByText("Direct validation history")).toBeVisible()
  await expect(page.getByText("Evidence snapshot")).toBeVisible()

  await page
    .getByRole("button", {
      name: "立即检查 source-1.publisher.example.test",
    })
    .click()
  await expect(page.getByText(/直接验证已进入耐久任务/)).toBeVisible()

  await page
    .getByRole("button", {
      name: "暂停监控 source-1.publisher.example.test",
    })
    .click()
  await expect(page.getByText(/监控策略已更新：Tier A · paused/)).toBeVisible()

  await page.getByRole("button", { name: "导入现有链接" }).click()
  await page
    .getByLabel("来源页面 URL")
    .fill("https://imported.publisher.example.test/article")
  await page
    .getByPlaceholder("https://example.com/target")
    .fill("https://owner.example.test/imported")
  await page.getByRole("button", { name: "导入库存" }).click()
  await expect(page.getByText(/已导入库存并分配 Tier A/)).toBeVisible()

  await page.getByRole("button", { name: "下一页 Backlink Inventory" }).click()
  await expect(page.getByText(/第 2 \/ 3 页/)).toBeVisible()

  await page.getByLabel("搜索 Backlink Inventory").fill("source-31")
  await expect(
    page.getByText("source-31.publisher.example.test", { exact: true })
  ).toBeVisible()

  await page.getByRole("button", { name: "立即同步" }).click()
  await expect(
    page.getByText("Provider 配置或预算不足，已保留当前快照。")
  ).toBeVisible()

  const syncRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith("/backlinks/profile-sync-jobs")
  )
  const importRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith("/backlinks/inventory-items")
  )
  const checkRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith("/inventory-e2e-1/checks")
  )
  const policyRequest = session.capturedRequests.find(
    (request) =>
      request.method === "PATCH" &&
      request.pathname.endsWith("/inventory-e2e-1/monitoring-policy")
  )
  expect(syncRequest?.idempotencyKey).toBeTruthy()
  expect(importRequest?.body).toMatchObject({
    sourceUrl: "https://imported.publisher.example.test/article",
    targetUrl: "https://owner.example.test/imported",
    managed: true,
  })
  expect(checkRequest?.idempotencyKey).toBeTruthy()
  expect(policyRequest?.body).toEqual({
    expectedVersion: 1,
    important: true,
    monitoringStatus: "paused",
  })
  expect(session.unexpectedNetwork).toEqual([])
})

test("an opportunity with no contact requires review and explicit confirmation", async ({
  page,
}) => {
  const session = await installOutreachApiFixtures(page, {
    contactMode: "none",
  })

  await page.goto(
    `/projects/${projectKey}/backlinks/drafts/new?opportunityId=${opportunityId}`
  )
  await expect(page.getByText("当前机会没有可用的已确认联系人。")).toBeVisible()

  await page.getByLabel("联系人邮箱").fill("confirmed@publisher.example.test")
  await page.getByRole("button", { name: "核对联系人" }).click()
  await expect(page.getByText("请最终确认联系人")).toBeVisible()
  await page.getByRole("button", { name: "确认并保存联系人" }).click()

  await expect(page.getByText("confirmed@publisher.example.test")).toBeVisible()
  await expect(page.getByText("editorial · 已自动选中")).toBeVisible()
  await expect(page.getByRole("button", { name: "生成草稿" })).toBeEnabled()

  const createCandidateRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith(
        `/opportunities/${opportunityId}/contacts/candidates`
      )
  )
  expect(createCandidateRequest?.idempotencyKey).toBeTruthy()
  expect(createCandidateRequest?.body).toEqual({
    normalizedEmail: "confirmed@publisher.example.test",
    contactRole: "editorial",
    reason: "已人工核对该邮箱属于当前机会的 Prospect，并确认可用于本次外联。",
  })

  const confirmCandidateRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith(
        "/contacts/candidates/contact-candidate-manual-e2e/confirm"
      )
  )
  expect(confirmCandidateRequest?.body).toEqual({
    expectedVersion: 1,
    contactRole: "editorial",
    reason: "已人工核对该邮箱属于当前机会的 Prospect，并确认可用于本次外联。",
  })
  expect(session.unexpectedNetwork).toEqual([])
})

test("draft generation keeps polling and refresh recovers the same Job", async ({
  page,
}) => {
  const session = await installOutreachApiFixtures(page, {
    draftJobStatuses: ["RUNNING", "RUNNING", "SUCCEEDED"],
  })
  const generationUrl = `/projects/${projectKey}/backlinks/drafts/new?opportunityId=${opportunityId}`

  await page.goto(generationUrl)
  await expect(page.getByRole("button", { name: "生成草稿" })).toBeEnabled()
  await page.getByRole("button", { name: "生成草稿" }).click()
  await expect
    .poll(
      () =>
        session.capturedRequests.filter(
          (request) =>
            request.method === "GET" &&
            request.pathname.endsWith("/draft-jobs/draft-job-e2e")
        ).length
    )
    .toBe(1)
  await expect(page.getByTestId("draft-job-diagnostics")).toBeHidden()
  await expect(page.getByRole("button", { name: "正在等待后端" })).toBeVisible()

  await page.reload()
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/backlinks/drafts/${draftId}$`),
    { timeout: 8_000 }
  )

  const createRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith(`/opportunities/${opportunityId}/draft-jobs`)
  )
  const statusRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname.endsWith("/draft-jobs/draft-job-e2e")
  )
  const recoveryRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname.endsWith(
        `/opportunities/${opportunityId}/draft-jobs/latest`
      )
  )
  expect(createRequests).toHaveLength(1)
  expect(statusRequests).toHaveLength(3)
  expect(recoveryRequests).toHaveLength(2)
  expect(session.unexpectedNetwork).toEqual([])
})
