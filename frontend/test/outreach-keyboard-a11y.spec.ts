import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Locator, type Page } from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

const { projectKey, opportunityId, draftId } = outreachFixture

async function tabTo(page: Page, locator: Locator, maxTabs = 100) {
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press("Tab")
    if (
      await locator
        .first()
        .evaluate((element) => element === document.activeElement)
        .catch(() => false)
    ) {
      return
    }
  }
  throw new Error(`Keyboard focus did not reach ${await locator.toString()}`)
}

async function arrowToTab(page: Page, locator: Locator, maxArrows = 10) {
  for (let index = 0; index < maxArrows; index += 1) {
    await page.keyboard.press("ArrowRight")
    if (
      await locator
        .evaluate((element) => element === document.activeElement)
        .catch(() => false)
    ) {
      return
    }
  }
  throw new Error(`Arrow-key focus did not reach ${await locator.toString()}`)
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const severe = results.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical"
  )
  expect(
    severe,
    severe
      .map(
        (violation) =>
          `${violation.id}: ${violation.help} (${violation.nodes.length})`
      )
      .join("\n")
  ).toEqual([])
}

test("critical Outreach commands are keyboard operable with no serious a11y violations", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const session = await installOutreachApiFixtures(page)

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  await expectNoSeriousA11yViolations(page)
  await tabTo(page, page.getByRole("button", { name: "加入 Opportunity" }))
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "已加入" })).toBeVisible()
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/backlinks/recommendations$`)
  )
  expect(
    session.capturedRequests.filter(
      (request) =>
        request.method === "POST" &&
        request.pathname.endsWith("/backlinks/opportunities")
    )
  ).toHaveLength(1)
  await tabTo(page, page.getByRole("tab", { name: "推荐池" }))
  await arrowToTab(page, page.getByRole("tab", { name: "外链机会" }))
  if (!page.url().endsWith("/backlinks/opportunities")) {
    await page.keyboard.press("Enter")
  }
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/backlinks/opportunities$`)
  )
  await tabTo(page, page.getByRole("button", { name: "详情" }))
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { name: "publisher.example.test" })
  ).toBeVisible()
  await expectNoSeriousA11yViolations(page)
  await tabTo(page, page.getByRole("link", { name: "撰写邮件" }))
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(
    new RegExp(
      `/projects/${projectKey}/backlinks/drafts/new\\?opportunityId=${opportunityId}$`
    )
  )
  await tabTo(page, page.getByRole("button", { name: "生成草稿" }))
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/backlinks/drafts/${draftId}$`)
  )
  await tabTo(page, page.getByRole("button", { name: "人工批准" }))
  await page.keyboard.press("Enter")
  await expect(page.getByText("当前草稿版本已人工批准。")).toBeVisible()
  await tabTo(page, page.getByRole("checkbox"))
  await page.keyboard.press("Space")
  await tabTo(page, page.getByRole("button", { name: "最终确认并发送" }))
  await page.keyboard.press("Enter")
  await expect(page.getByText("Gmail Provider 已接受")).toBeVisible()
  await expectNoSeriousA11yViolations(page)

  await page.goto(`/projects/${projectKey}/backlinks/email`)
  const messageButton = page.getByRole("button", {
    name: /Re: E2E collaboration/,
  })
  await tabTo(page, messageButton)
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { name: "回信人工确认" })
  ).toBeVisible()
  await tabTo(page, page.getByRole("radio"))
  await page.keyboard.press("Space")
  await tabTo(page, page.getByPlaceholder("记录人工核对依据"))
  await page.keyboard.type("Keyboard-confirmed local E2E match.")
  await tabTo(page, page.getByRole("button", { name: "确认关联" }))
  await page.keyboard.press("Enter")
  await expect(page.getByText("已关联到外链机会")).toBeVisible()
  await expectNoSeriousA11yViolations(page)

  await page.goto(`/projects/${projectKey}/performance/links`)
  await tabTo(page, page.getByRole("tab", { name: "Confirmed" }), 180)
  await page.keyboard.press("Enter")
  await expect(
    page.getByText("https://publisher.example.test/article")
  ).toBeVisible()
  await tabTo(
    page,
    page.getByRole("button", { name: "查看 confirmed 链接详情" })
  )
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { name: "Placement 链接详情" })
  ).toBeVisible()
  await expectNoSeriousA11yViolations(page)

  expect(session.unexpectedNetwork).toEqual([])
})
