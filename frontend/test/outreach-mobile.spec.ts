import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Locator, type Page } from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

const { projectKey, opportunityId, draftId } = outreachFixture

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1)
}

async function expectInsideViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1)
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

test("mobile key pages remain visible without page-level overflow", async ({
  page,
}, testInfo) => {
  const session = await installOutreachApiFixtures(page)

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  const outreachHeading = page.getByRole("heading", {
    name: "外链",
    exact: true,
  })
  await expect(outreachHeading).toBeVisible()
  await expectInsideViewport(page, outreachHeading)
  await expectInsideViewport(page, page.getByRole("tablist"))
  await expectNoPageOverflow(page)
  await expectNoSeriousA11yViolations(page)

  await page.getByRole("tab", { name: "外链机会" }).click()
  await page.getByRole("button", { name: "详情" }).click()
  await page.getByRole("link", { name: "撰写邮件" }).click()
  await expect(page).toHaveURL(
    new RegExp(
      `/projects/${projectKey}/backlinks/drafts/new\\?opportunityId=${opportunityId}$`
    )
  )
  const generationHeading = page.getByRole("heading", {
    name: "生成邮件草稿",
  })
  await expect(generationHeading).toBeVisible()
  await expect(page.getByText("editor@publisher.example.test")).toBeVisible()
  await expectInsideViewport(page, generationHeading)
  await expectNoPageOverflow(page)
  await expectNoSeriousA11yViolations(page)
  await page.getByRole("button", { name: "生成草稿" }).click()
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/backlinks/drafts/${draftId}$`)
  )
  await page.getByRole("button", { name: "人工批准" }).click()
  await expect(page.getByText("当前草稿版本已人工批准。")).toBeVisible()
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "最终确认并发送" }).click()
  await expect(page.getByText("Gmail Provider 已接受")).toBeVisible()
  await expectNoPageOverflow(page)
  await expectNoSeriousA11yViolations(page)

  await page.goto(`/projects/${projectKey}/backlinks/email`)
  await page.getByText("Re: E2E collaboration", { exact: true }).click()
  const manualMatchHeading = page.getByRole("heading", {
    name: "回信人工确认",
  })
  await expect(manualMatchHeading).toBeVisible()
  await expectInsideViewport(page, manualMatchHeading)
  await expectNoPageOverflow(page)
  await expectNoSeriousA11yViolations(page)

  await page.goto(`/projects/${projectKey}/performance/links`)
  const profileHeading = page.getByRole("heading", {
    name: "Backlink Profile",
  })
  await expect(profileHeading).toBeVisible()
  await expectInsideViewport(page, profileHeading)
  await expect(page.getByText("Partial", { exact: true })).toBeVisible()
  await expectNoPageOverflow(page)
  await page.getByRole("tab", { name: "Confirmed" }).click()
  await page.getByRole("button", { name: "查看 confirmed 链接详情" }).click()
  const placementHeading = page.getByRole("heading", {
    name: "Placement 链接详情",
  })
  await expect(placementHeading).toBeVisible()
  await expectInsideViewport(page, placementHeading)
  await expectNoPageOverflow(page)
  await expectNoSeriousA11yViolations(page)

  const screenshot = await page.screenshot({
    path: testInfo.outputPath("lp-final-mobile-product-flow.png"),
    fullPage: true,
  })
  await testInfo.attach("lp-final-mobile-product-flow", {
    body: screenshot,
    contentType: "image/png",
  })

  expect(session.unexpectedNetwork).toEqual([])
})

test("390px recommendation generation remains readable through server completion", async ({
  page,
}) => {
  const session = await installOutreachApiFixtures(page, {
    recommendationMode: "generate",
    recommendationCompleteAfterReads: 3,
  })

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  const generate = page.getByRole("button", { name: "生成推荐" })
  await expect(generate).toBeVisible()
  await expectInsideViewport(page, generate)
  await generate.click()

  await expect(page.getByText(/已耗时 2分/)).toBeVisible()
  await expectNoPageOverflow(page)
  await expectNoSeriousA11yViolations(page)
  await expect(
    page.getByRole("link", {
      name: "publisher.example.test",
      exact: true,
    })
  ).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText("产品：E2E product")).toBeVisible()
  await expect(page.getByText("查看公开证据 · visible_text")).toBeVisible()
  await expectNoPageOverflow(page)
  await expectNoSeriousA11yViolations(page)

  expect(
    session.capturedRequests.filter(
      (request) =>
        request.method === "POST" &&
        request.pathname.endsWith("/recommendation-refill-jobs")
    )
  ).toHaveLength(1)
  expect(session.unexpectedNetwork).toEqual([])
})
