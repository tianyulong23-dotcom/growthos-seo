import { expect, test } from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

const { draftId, projectKey, sendIntentId } = outreachFixture

test("accepted Gmail send replaces queued copy and keeps Mail Center truthful", async ({
  page,
}, testInfo) => {
  const session = await installOutreachApiFixtures(page)

  await page.goto(`/projects/${projectKey}/backlinks/drafts/${draftId}`)
  await expect(page.getByLabel("邮件主题")).toHaveValue(
    "E2E collaboration proposal"
  )

  await page.getByRole("button", { name: "人工批准" }).click()
  await expect(page.getByText("当前草稿版本已人工批准。")).toBeVisible()
  const sendConfirmation = page.getByRole("checkbox")
  const sendButton = page.getByRole("button", { name: "确认并发送" })
  await sendConfirmation.click()
  await expect(sendConfirmation).toBeChecked()
  await expect(sendButton).toBeEnabled()
  await sendButton.click()

  await expect(page.getByRole("heading", { name: "邮件已发送" })).toBeVisible()
  await expect(page.getByText("邮件发送成功")).toBeVisible()
  await expect(
    page.getByText(
      "已创建 Send Intent，当前为 QUEUED；正在读取服务端状态，尚未确认 Gmail 接受。"
    )
  ).toHaveCount(0)
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

  await page.goto(`/projects/${projectKey}/backlinks/email`)
  await expect(page.getByText("邮件同步可用")).toBeVisible()
  await expect(page.getByText("发送与同步尚未就绪")).toHaveCount(0)
  await expect(
    page.getByText("需要具体草稿和收件人才能完成发送预检")
  ).toHaveCount(0)

  const screenshot = await page.screenshot({
    path: testInfo.outputPath("mail-center-ready.png"),
    fullPage: true,
  })
  await testInfo.attach("mail-center-ready", {
    body: screenshot,
    contentType: "image/png",
  })

  expect(session.unexpectedNetwork).toEqual([])
})
