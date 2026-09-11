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
  const profileSummary = page
    .getByRole("heading", { name: "外链表现" })
    .locator("..")
  await expect(profileSummary).toBeVisible()
  await expect(
    profileSummary.getByText("owner.example.test", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("净变化", { exact: true })).toBeVisible()
  await expect(page.getByText("+1", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "已确认外链", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("最近一次 Direct Monitor 尝试失败", { exact: false })
  ).toBeVisible()
  await expect(page.getByText("全部外链", { exact: true })).toBeVisible()
  await expect(page.getByText("数据口径")).toBeVisible()
  const inventoryTable = page.getByRole("table", {
    name: "全部外链列表",
  })
  await expect(inventoryTable).toBeVisible()
  expect(
    await inventoryTable.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true)
  const firstInventorySource = page.getByRole("link", {
    name: /source-1\.publisher\.example\.test/,
  })
  await expect(firstInventorySource).toBeVisible()
  await expect(
    firstInventorySource.getByText("/article", { exact: true })
  ).toBeVisible()

  let inventoryRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname === `/api/v1/projects/${projectKey}/backlinks/inventory`
  )
  expect(inventoryRequests.length).toBeGreaterThan(0)
  expect(
    new URLSearchParams(inventoryRequests.at(-1)?.search).get("view")
  ).toBeNull()

  await page.getByRole("button", { name: "查看引用域" }).click()
  await expect(
    page.getByRole("heading", { name: "引用域明细", exact: true })
  ).toBeVisible()
  await expect(page.getByRole("table", { name: "引用域列表" })).toBeVisible()
  await expect(page.getByText("已采集 41 个引用域")).toBeVisible()
  inventoryRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname === `/api/v1/projects/${projectKey}/backlinks/inventory`
  )
  expect(
    new URLSearchParams(inventoryRequests.at(-1)?.search).get("view")
  ).toBe("referring_domains")

  await page.getByRole("button", { name: "查看新增外链" }).click()
  await expect(
    page.getByRole("heading", { name: "新增外链", exact: true })
  ).toBeVisible()
  await expect(page.getByRole("table", { name: "新增外链列表" })).toBeVisible()
  await expect(page.getByText("本次新增 7 条")).toBeVisible()
  inventoryRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname === `/api/v1/projects/${projectKey}/backlinks/inventory`
  )
  expect(
    new URLSearchParams(inventoryRequests.at(-1)?.search).get("view")
  ).toBe("new")

  await page.getByRole("button", { name: "查看丢失外链" }).click()
  await expect(
    page.getByRole("heading", { name: "丢失外链", exact: true })
  ).toBeVisible()
  await expect(page.getByRole("table", { name: "丢失外链列表" })).toBeVisible()
  await expect(page.getByText("本次丢失 6 条")).toBeVisible()
  inventoryRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname === `/api/v1/projects/${projectKey}/backlinks/inventory`
  )
  expect(
    new URLSearchParams(inventoryRequests.at(-1)?.search).get("view")
  ).toBe("lost")

  await page.getByRole("button", { name: "查看全部外链" }).click()
  await expect(page.getByRole("table", { name: "全部外链列表" })).toBeVisible()
  const profileRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname === `/api/v1/projects/${projectKey}/backlinks/profile`
  )
  expect(profileRequests.length).toBeGreaterThan(0)

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

test("Backlink monitoring and reports are grouped under Performance", async ({
  page,
}) => {
  const session = await installOutreachApiFixtures(page)

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  await expect(page.getByRole("tab", { name: "推荐池" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "外链监控" })).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "指标报告" })).toHaveCount(0)

  await page.goto(`/projects/${projectKey}/performance/reports`)
  await expect(
    page.getByRole("heading", { name: "效果", exact: true })
  ).toBeVisible()
  await expect(page.getByRole("tab", { name: "指标报告" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(
    page.getByRole("heading", { name: "外链事实指标", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Active Placement", { exact: true })
  ).toBeVisible()
  expect(session.unexpectedNetwork).toEqual([])
})
