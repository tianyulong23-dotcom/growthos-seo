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
  await expect(page.getByText("评分 92", { exact: true })).toBeVisible()

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
  expect(sendRequest?.idempotencyKey).toBeTruthy()
  expect(sendRequest?.body).toEqual({
    approvedDraftVersionId: draftVersionId,
    contactId,
    contactVersion: 1,
    gmailConnectionId: "gmail-connection-e2e",
    messagePurpose: "INITIAL_OUTREACH",
    followUpIndex: 0,
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
  await expect(
    page.getByText("服务端生成、校验或保存中", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("已耗时", { exact: true })).toBeVisible()
  await expect(page.getByText("最后成功查询", { exact: true })).toBeVisible()
  await expect(page.getByText("服务端查询次数", { exact: true })).toBeVisible()
  await expect(page.getByText("尚未成功查询", { exact: true })).toHaveCount(0)

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
