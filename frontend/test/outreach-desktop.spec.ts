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
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("受众与项目匹配", { exact: true })).toBeVisible()
  await expect(page.getByText("12,500", { exact: true })).toBeVisible()

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
  await page.getByRole("link", { name: "创建邮件草稿" }).click()
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
  const sendConfirmation = page.getByRole("checkbox", {
    name: "我已核对发件账号、收件人和已批准版本，并确认立即发送。",
  })
  await expect(sendConfirmation).toBeEnabled()
  await sendConfirmation.click()
  await expect(sendConfirmation).toBeChecked()
  const sendButton = page.getByRole("button", {
    name: "确认并发送",
    exact: true,
  })
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
  await expect(page.getByText("邮件发送成功")).toBeVisible()

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

  await page.goto(`/projects/${projectKey}/backlinks/links`)
  await expect(
    page.getByRole("heading", { name: "Backlink Profile" })
  ).toBeVisible()
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
  const sendConfirmation = page.getByRole("checkbox", {
    name: "我已核对发件账号、收件人和已批准版本，并确认立即发送。",
  })
  await expect(sendConfirmation).toBeEnabled()
  await sendConfirmation.click()
  await expect(sendConfirmation).toBeChecked()
  const sendButton = page.getByRole("button", {
    name: "确认并发送",
    exact: true,
  })
  await expect(sendButton).toBeEnabled()
  await sendButton.click()

  await expect(page.getByText("邮件发送成功")).toBeVisible()
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

test("recommendation feed remains V2 across navigation and refresh without V1 writes", async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000)
  const session = await installOutreachApiFixtures(page, {
    recommendationPoolSize: 20,
  })

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  await expect(
    page.getByRole("heading", { name: "外链推荐", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("link", {
      name: "publisher.example.test",
      exact: true,
    })
  ).toBeVisible()
  await expect(page.getByText("共 20 条已发布推荐")).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("recommendation-feed-v2-desktop.png"),
    fullPage: true,
  })

  await page.getByRole("tab", { name: "外链机会" }).click()
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/backlinks/opportunities$`)
  )
  await page.getByRole("tab", { name: "推荐池" }).click()
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/backlinks/recommendations$`)
  )
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
  ).toBeVisible({ timeout: 20_000 })
  expect(
    session.capturedRequests.filter((request) =>
      request.pathname.includes("/recommendation-feed")
    ).length
  ).toBeGreaterThanOrEqual(2)
  expect(
    session.capturedRequests.filter(
      (request) =>
        request.pathname.endsWith("/backlinks/recommendations") ||
        request.pathname.includes("/recommendation-inventory") ||
        request.pathname.includes("/recommendation-refill-jobs") ||
        request.pathname.includes("/recommendation-pools/")
    )
  ).toHaveLength(0)
  expect(session.unexpectedNetwork).toEqual([])
})

test("recommendation details hide unavailable website metrics", async ({
  page,
}) => {
  await installOutreachApiFixtures(page, {
    recommendationMetricsMode: "unavailable",
  })

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  const recommendation = page.locator("article").filter({
    has: page.getByRole("link", {
      name: "publisher.example.test",
      exact: true,
    }),
  })
  await expect(recommendation.getByText("暂无数据", { exact: true })).toHaveCount(3)
  await expect(recommendation.getByText("0", { exact: true })).toHaveCount(0)
  await expect(page.getByText("高适合度")).toHaveCount(0)
  await expect(page.getByText("推荐依据", { exact: true })).toHaveCount(0)
})

test("recommendation feed uses V2 Opportunity, archive, undo, and get-more contracts", async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000)
  const session = await installOutreachApiFixtures(page, {
    recommendationPoolSize: 20,
  })

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  const firstRecommendation = page.locator("article").filter({
    has: page.getByRole("link", {
      name: "publisher.example.test",
      exact: true,
    }),
  })
  await firstRecommendation.getByRole("button", { name: "加入" }).click()
  await expect(
    firstRecommendation.getByText("已加入外链机会", { exact: true })
  ).toBeVisible()
  const joinButton = firstRecommendation.getByRole("button", {
    name: "加入",
    exact: true,
  })
  await expect(joinButton).toBeDisabled()
  await page.reload()
  await expect(joinButton).toBeDisabled()
  const opportunityRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith("/backlinks/opportunities")
  )
  expect(opportunityRequest?.body).toEqual({
    recommendationFeedItemId: "018f0000-0000-7000-8000-000000000801",
  })
  expect(
    session.capturedRequests.filter(
      (request) =>
        request.method === "POST" &&
        request.pathname.endsWith("/backlinks/opportunities")
    )
  ).toHaveLength(1)

  await firstRecommendation.getByRole("button", { name: "归档" }).click()
  await expect(page.getByText("publisher.example.test 已归档")).toBeVisible()
  const archiveRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith(
        "/recommendation-user-release/items/018f0000-0000-7000-8000-000000000801/archive"
      )
  )
  expect(archiveRequests).toHaveLength(1)
  expect(archiveRequests[0]?.idempotencyKey).toBe(
    "recommendation-feed:archive:e2e-project:018f0000-0000-7000-8000-000000000801"
  )

  await page.getByRole("button", { name: "撤销" }).click()
  await expect(
    page.getByRole("link", { name: "publisher.example.test", exact: true })
  ).toBeVisible()
  const unarchiveRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith(
        "/recommendation-user-release/items/018f0000-0000-7000-8000-000000000801/unarchive"
      )
  )
  expect(unarchiveRequest?.idempotencyKey).toBe(
    "recommendation-feed:unarchive:e2e-project:018f0000-0000-7000-8000-000000000801"
  )

  await page.getByRole("button", { name: "获取更多" }).click()
  await expect(
    page.getByRole("link", {
      name: "publisher-v2-b2-01.example.test",
      exact: true,
    })
  ).toBeVisible()
  const getMoreRequest = session.capturedRequests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith("/recommendation-user-release/get-more")
  )
  expect(getMoreRequest?.idempotencyKey).toBeTruthy()
  expect(
    session.capturedRequests.filter(
      (request) =>
        request.pathname.endsWith("/backlinks/recommendations") ||
        request.pathname.includes("/recommendation-inventory") ||
        request.pathname.includes("/recommendation-refill-jobs") ||
        request.pathname.includes("/recommendation-pools/")
    )
  ).toHaveLength(0)

  const screenshot = await page.screenshot({
    path: testInfo.outputPath("recommendation-feed-v2-actions.png"),
    fullPage: true,
  })
  await testInfo.attach("recommendation-feed-v2-actions", {
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

  await page.goto(`/projects/${projectKey}/backlinks/links`)
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
  await expect(page.getByText("暂无带有效网页证据的待确认邮箱。")).toBeVisible()
  const generateButton = page.getByRole("button", { name: "生成草稿", exact: true })
  await expect(generateButton).toBeDisabled()
  await page.getByText("手动添加其他邮箱", { exact: true }).click()

  await page.getByLabel("联系人邮箱").fill("confirmed@publisher.example.test")
  await page
    .getByLabel("确认依据")
    .fill("已人工核对该邮箱属于当前机会的 Prospect，并确认可用于本次外联。")
  await page.getByRole("button", { name: "核对联系人" }).click()
  await expect(page.getByText("请最终确认联系人")).toBeVisible()
  await expect(generateButton).toBeDisabled()
  expect(
    session.capturedRequests.filter(
      (request) =>
        request.method === "POST" &&
        /\/contacts\/candidates|\/draft-jobs/.test(request.pathname)
    )
  ).toHaveLength(0)
  await page.getByRole("button", { name: "确认并保存联系人" }).click()

  await expect(page.getByText("confirmed@publisher.example.test")).toBeVisible()
  await expect(page.getByText("编辑 · 已选中")).toBeVisible()
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
  await generateButton.click()
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/backlinks/drafts/${draftId}$`)
  )
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
