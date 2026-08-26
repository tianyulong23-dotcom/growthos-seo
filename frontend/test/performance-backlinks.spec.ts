import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Locator, type Page } from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

const { placementId, projectKey } = outreachFixture

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    layoutWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.layoutWidth + 1)
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

test("Performance Backlinks preserves lineage and historical evidence without real providers", async ({
  page,
}, testInfo) => {
  const session = await installOutreachApiFixtures(page, {
    performanceBacklinksMode: "provider_failed",
  })

  await page.goto(`/projects/${projectKey}/performance/backlinks`)

  const heading = page.getByRole("heading", { name: "效果", exact: true })
  await expect(heading).toBeVisible()
  await expect(page.getByRole("tab", { name: "外链监控" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(page.getByText("项目级 Placement 成效")).toBeVisible()
  await expect(
    page.getByText("最近一次 Direct Monitor 尝试失败", { exact: false })
  ).toBeVisible()
  await expect(page.getByText("计入外链成效 KPI")).toBeVisible()
  await expect(page.getByText("不计入成效 KPI").first()).toBeVisible()
  await expect(page.getByText("DataForSEO", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Direct Monitor", { exact: true }).first()
  ).toBeVisible()
  await expect(page.getByText("Indexification / 索引")).toBeVisible()

  const openDetail = page.getByRole("button", {
    name: "查看 https://publisher.example.test/article 监控详情",
  })
  await expect(openDetail).toBeVisible()
  await openDetail.click()

  const detailHeading = page.getByRole("heading", {
    name: "外链证据与时间线",
  })
  const detailSheet = page.getByLabel("外链证据与时间线")
  await expect(detailHeading).toBeVisible()
  await expect(page.getByText("外联归因")).toBeVisible()
  await expect(
    detailSheet.getByText("opportunity-e2e", { exact: true })
  ).toBeVisible()
  await expect(
    detailSheet.getByText("inbound-message-e2e", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("Placement 已确认")).toBeVisible()

  await page.getByRole("button", { name: "读取证据" }).click()
  await expect(
    detailSheet.getByText("sha256:observation-e2e", { exact: false })
  ).toBeVisible()

  const reverifyButton = detailSheet.getByRole("button", {
    name: "重新验证",
    exact: true,
  })
  await reverifyButton.click()
  await expect(page.getByText("已受理，监控任务状态：scheduled")).toBeVisible()

  const reverifyRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "POST" &&
      request.pathname ===
        `/api/v1/projects/${projectKey}/backlinks/links/placements/${placementId}/reverify`
  )
  expect(reverifyRequests).toHaveLength(1)
  expect(reverifyRequests[0]?.body).toEqual({ expectedVersion: 4 })
  expect(reverifyRequests[0]?.idempotencyKey).toBeTruthy()
  expect(session.unexpectedNetwork).toEqual([])

  await expectInsideViewport(page, detailHeading)
  await expectInsideViewport(page, reverifyButton)
  await expectInsideViewport(
    page,
    detailSheet.getByRole("button", { name: "Close" })
  )
  await expectNoPageOverflow(page)
  await expectNoSeriousA11yViolations(page)

  const screenshot = await page.screenshot({
    path: testInfo.outputPath(
      `performance-backlinks-${testInfo.project.name}.png`
    ),
    fullPage: true,
  })
  await testInfo.attach("performance-backlinks", {
    body: screenshot,
    contentType: "image/png",
  })
})
