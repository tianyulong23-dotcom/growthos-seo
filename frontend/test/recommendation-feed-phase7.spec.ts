import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

const { projectKey } = outreachFixture
const firstItemId = "018f0000-0000-7000-8000-000000000701"
const secondItemId = "018f0000-0000-7000-8000-000000000702"
const generatedAt = "2026-08-31T00:00:00.000Z"

type CapturedRequest = {
  method: string
  pathname: string
  search: string
  body: unknown
}

function meta(schemaVersion: string, requestId: string) {
  return {
    organizationId: "organization-e2e",
    workspaceId: "workspace-e2e",
    websiteProjectId: projectKey,
    requestId,
    schemaVersion,
    generatedAt,
  }
}

function feedItem(
  itemId: string,
  domain: string,
  archived: boolean,
  opportunityCreated: boolean
) {
  return {
    itemId,
    domain,
    displayUrl: `https://${domain}/`,
    recommended: true,
    reasons: [
      "受众与项目匹配",
      "内容主题相关",
      "RELEVANCE_TARGET_MARKET_SEARCH_TOPIC",
      "COMMERCIAL_FIT_V4_ELIGIBLE_PARTIAL_EVIDENCE",
    ],
    category: "Editorial",
    metrics: {
      targetMarketOrganicTraffic: null,
      dataForSeoRank: null,
      spamScore: null,
      ahrefsDr: 0,
      libraryMonthlyTraffic: 12345,
    },
    contact: {
      email: null,
      contactPage: `https://${domain}/contact`,
      outcome: "CONTACT_PAGE_FOUND",
    },
    opportunity: {
      opportunityId: opportunityCreated ? "opportunity-phase7-e2e" : null,
      businessStage: opportunityCreated ? "JOINED" : null,
      managementStatus: opportunityCreated ? "ACTIVE" : null,
      outcomeStatus: opportunityCreated ? "OPEN" : null,
      createdByCurrentUser: opportunityCreated,
    },
    archived,
    releasedAt: "2026-08-31T01:00:00.000Z",
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  })
}

async function installRecommendationFeedV2Fixtures(
  page: Page,
  options: { initialPublished?: boolean; ready?: boolean } = {}
) {
  const requests: CapturedRequest[] = []
  let firstArchived = false
  let opportunityCreated = false
  let moreReleased = false
  let initialPublished = options.initialPublished ?? true
  const ready = options.ready ?? true

  await page.route(
    `**/api/v1/projects/${projectKey}/backlinks/**`,
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const method = request.method()
      const pathname = url.pathname

      const isPhase7Path =
        pathname.includes("/recommendation-feed") ||
        pathname.includes("/recommendation-user-release") ||
        pathname.endsWith("/backlinks/opportunities")
      if (!isPhase7Path) {
        return route.fallback()
      }

      requests.push({
        method,
        pathname,
        search: url.search,
        body: request.postData() ? request.postDataJSON() : null,
      })

      if (
        method === "GET" &&
        pathname.endsWith("/backlinks/recommendation-feed")
      ) {
        const cursor = url.searchParams.get("cursor")
        const item =
          cursor === "cursor-page-2"
            ? feedItem(secondItemId, "second.publisher.example", false, false)
            : feedItem(
                firstItemId,
                initialPublished ? "publisher.example" : "historical.example",
                firstArchived,
                opportunityCreated
              )
        return json(route, {
          items: [item],
          releasedPool: {
            generationCount: 1,
            oldestVisiblePoolGeneration: 1,
            newestVisiblePoolGeneration: initialPublished ? 2 : 1,
          },
          latestGeneration: {
            generationContractId: "018f0000-0000-7000-8000-000000000703",
            visiblePoolGeneration: 2,
            jobState: "SUCCESS",
            progress: 100,
            discoveryResult: "COMPLETED",
            contactPreparation: "COMPLETED",
            releaseResult: ready ? "AVAILABLE" : "PENDING",
            effectiveUniqueCandidateCount: 12,
            admittedCount: 10,
            releasedCount: 2,
            terminalReason: null,
            retrySafe: false,
          },
          totalCount: 2,
          nextCursor: cursor === "cursor-page-2" ? null : "cursor-page-2",
          meta: meta("backlinks.recommendation-feed.v2", "feed-phase7-e2e"),
        })
      }

      if (
        method === "POST" &&
        pathname.endsWith("/backlinks/recommendation-feed/export")
      ) {
        return route.fulfill({
          status: 200,
          contentType: "text/csv",
          body: "domain,category\npublisher.example,Editorial\n",
        })
      }

      if (
        method === "GET" &&
        pathname.endsWith("/backlinks/recommendation-user-release/status")
      ) {
        return json(route, {
          state: initialPublished ? "PUBLISHED" : "NOT_PUBLISHED",
          currentBatchOrdinal: initialPublished ? (moreReleased ? 2 : 1) : null,
          requiredOpportunityCount: 1,
          successfulOpportunityCount: opportunityCreated ? 1 : 0,
          unlockAt: "2026-08-31T18:00:00.000Z",
          unlockReason: opportunityCreated
            ? "OPPORTUNITY_RATIO"
            : "ELAPSED_18H",
          canGetMore: initialPublished && !moreReleased,
          getMoreState: !initialPublished
            ? "INITIAL_BATCH_NOT_PUBLISHED"
            : moreReleased
              ? "POOL_EXHAUSTED"
              : "RELEASE_NEXT",
          meta: meta(
            "backlinks.recommendation-user-release.v2",
            "status-phase7-e2e"
          ),
        })
      }

      if (
        method === "POST" &&
        pathname.endsWith("/recommendation-user-release/publish-initial")
      ) {
        const replayed = initialPublished
        initialPublished = ready
        return json(route, {
          state: ready ? "PUBLISHED" : "NOT_READY",
          currentBatchOrdinal: ready ? 1 : null,
          replayed,
          meta: meta("backlinks.recommendation-user-release.v2", "initial-e2e"),
        })
      }

      if (
        method === "POST" &&
        pathname.endsWith("/backlinks/recommendation-user-release/get-more")
      ) {
        moreReleased = true
        return json(route, {
          state: "RELEASED",
          currentBatchOrdinal: 2,
          releasedBatchOrdinal: 2,
          replayed: false,
          meta: meta(
            "backlinks.recommendation-user-release.v2",
            "get-more-phase7-e2e"
          ),
        })
      }

      if (
        method === "POST" &&
        pathname.endsWith(
          `/backlinks/recommendation-user-release/items/${firstItemId}/archive`
        )
      ) {
        firstArchived = true
        return json(route, {
          itemId: firstItemId,
          archived: true,
          replayed: false,
          meta: meta(
            "backlinks.recommendation-user-release.v2",
            "archive-phase7-e2e"
          ),
        })
      }

      if (
        method === "POST" &&
        pathname.endsWith(
          `/backlinks/recommendation-user-release/items/${firstItemId}/unarchive`
        )
      ) {
        firstArchived = false
        return json(route, {
          itemId: firstItemId,
          archived: false,
          replayed: false,
          meta: meta(
            "backlinks.recommendation-user-release.v2",
            "unarchive-phase7-e2e"
          ),
        })
      }

      if (method === "POST" && pathname.endsWith("/backlinks/opportunities")) {
        opportunityCreated = true
        return json(
          route,
          {
            opportunityId: "opportunity-phase7-e2e",
            recommendationId: "recommendation-phase7-e2e",
            cycleId: "cycle-phase7-e2e",
            websiteProjectId: projectKey,
            targetSiteKey: "publisher.example",
            targetHostAscii: "publisher.example",
            contactCandidateId: null,
            contactReviewRequired: true,
            joinSequence: 1,
            businessStage: "JOINED",
            managementStatus: "ACTIVE",
            outcomeStatus: "OPEN",
            fulfillmentStatus: "NOT_EXPECTED",
            version: 1,
            lifecycleEventId: "lifecycle-phase7-e2e",
            auditEventId: "audit-phase7-e2e",
            replayed: false,
            recommendationFeedItemId: firstItemId,
            existingOpportunity: false,
            teamAdded: false,
            createdByCurrentUser: true,
            meta: meta("backlinks.v1", "opportunity-phase7-e2e"),
          },
          201
        )
      }

      if (
        method === "POST" &&
        pathname.endsWith("/backlinks/recommendation-feed/observations")
      ) {
        return json(route, { recorded: true })
      }

      return json(route, { detail: "Unexpected Phase 7 request" }, 501)
    }
  )

  return { requests }
}

test("publishes the ready native first batch for the current member without discovery", async ({
  page,
}) => {
  const base = await installOutreachApiFixtures(page)
  const fixture = await installRecommendationFeedV2Fixtures(page, {
    initialPublished: false,
  })
  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  await expect(
    page.getByRole("link", { name: "publisher.example", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "historical.example", exact: true })
  ).toHaveCount(0)
  await expect(page.getByRole("button", { name: "获取更多" })).toBeEnabled()
  expect(
    fixture.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.pathname.endsWith("/publish-initial")
    )
  ).toHaveLength(1)
  expect(
    [...base.capturedRequests, ...fixture.requests].filter((request) =>
      /discovery|provider|workflow|seeds|launch|get-more/.test(request.pathname)
    )
  ).toEqual([])
})

test("does not publish a first batch whose preparation is incomplete", async ({
  page,
}) => {
  await installOutreachApiFixtures(page)
  const fixture = await installRecommendationFeedV2Fixtures(page, {
    initialPublished: false,
    ready: false,
  })
  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)
  await expect(
    page.getByRole("link", { name: "historical.example", exact: true })
  ).toBeVisible()
  expect(
    fixture.requests.filter(
      (request) =>
        request.method === "POST" &&
        !request.pathname.endsWith("/recommendation-feed/observations")
    )
  ).toEqual([])
  await expect.poll(() => fixture.requests.filter(
    (request) => request.pathname.endsWith("/recommendation-feed/observations")
  ).length).toBe(1)
  expect(fixture.requests.find(
    (request) => request.pathname.endsWith("/recommendation-feed/observations")
  )?.body).toEqual({
    generationContractId: "018f0000-0000-7000-8000-000000000703",
    observedState: "SUCCESS|COMPLETED|COMPLETED|PENDING",
    clientObservedAt: expect.any(String),
  })
})

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth
    const offenders = Array.from(
      document.querySelectorAll<HTMLElement>("body *")
    )
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          tagName: element.tagName,
          className: element.className,
          text: element.textContent?.trim().slice(0, 120) ?? "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }
      })
      .filter((element) => element.left < -1 || element.right > clientWidth + 1)
      .slice(0, 20)

    return {
      clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders,
    }
  })
  expect(
    dimensions.scrollWidth,
    JSON.stringify(dimensions.offenders, null, 2)
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1)
}

async function expectInsideViewport(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1)
}

test("released V2 recommendations remain usable on desktop and mobile without provider edges", async ({
  page,
}, testInfo) => {
  const baseSession = await installOutreachApiFixtures(page)
  const phase7 = await installRecommendationFeedV2Fixtures(page)

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)

  const heading = page.getByRole("heading", { name: "外链推荐" })
  await expect(heading).toBeVisible()
  await expect(page.getByLabel("推荐池供应状态")).toBeVisible()
  await expect(page.getByLabel("推荐筛选")).toBeVisible()
  await expect(
    page.getByRole("link", { name: "publisher.example", exact: true })
  ).toBeVisible()
  await expect(page.getByText("受众与项目匹配")).toBeVisible()
  await expect(page.getByRole("link", { name: "打开联系页面" })).toBeVisible()
  await expect(page.getByText("暂无数据", { exact: true })).toHaveCount(3)
  await expect(page.getByText("Ahrefs DR", { exact: true })).toBeVisible()
  await expect(page.getByText("库月流量", { exact: true })).toBeVisible()
  await expect(page.locator("article").getByText("0", { exact: true })).toBeVisible()
  await expect(page.locator("article").getByText("12,345", { exact: true })).toBeVisible()
  expect(phase7.requests.some((request) =>
    request.method === "GET" &&
    request.pathname.endsWith("/recommendation-feed") &&
    new URLSearchParams(request.search).get("limit") === "35"
  )).toBe(true)
  await expect(page.getByText(/score/i)).toHaveCount(0)
  await expect(page.getByText(/补池|重新生成/)).toHaveCount(0)

  await page.getByLabel("搜索域名").fill("publisher")
  await expect
    .poll(() =>
      phase7.requests.some(
        (request) =>
          request.method === "GET" &&
          new URLSearchParams(request.search).get("domainSearch") ===
            "publisher"
      )
    )
    .toBe(true)

  await page.getByLabel("排序").selectOption("domain_asc")
  await expect
    .poll(() =>
      phase7.requests.some(
        (request) =>
          request.method === "GET" &&
          new URLSearchParams(request.search).get("sort") === "domain_asc"
      )
    )
    .toBe(true)

  await page.getByRole("button", { name: "下一页" }).click()
  await expect(
    page.getByRole("link", {
      name: "second.publisher.example",
      exact: true,
    })
  ).toBeVisible()
  await page.getByRole("button", { name: "上一页" }).click()
  await expect(
    page.getByRole("link", { name: "publisher.example", exact: true })
  ).toBeVisible()

  await page.getByLabel("选择 publisher.example").check()
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("button", { name: "导出" }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(
    "owner.example.test-recommendations.csv"
  )
  const exportRequest = phase7.requests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname.endsWith("/recommendation-feed/export")
  )
  expect(exportRequest?.body).toMatchObject({
    selectedItemIds: [firstItemId],
  })

  await page.getByRole("button", { name: "加入" }).click()
  await expect(page.getByText("已加入外链机会", { exact: true })).toBeVisible()
  expect(
    phase7.requests.find((request) =>
      request.pathname.endsWith("/backlinks/opportunities")
    )?.body
  ).toEqual({ recommendationFeedItemId: firstItemId })

  await page.getByRole("button", { name: "归档" }).click()
  await expect(page.getByText("publisher.example 已归档")).toBeVisible()
  await page.getByRole("button", { name: "撤销", exact: true }).click()
  await expect(page.getByRole("button", { name: "归档" })).toBeVisible()

  await page.getByRole("button", { name: "获取更多" }).click()
  await expect(
    page.getByRole("button", { name: "暂无更多结果" })
  ).toBeDisabled()
  expect(
    phase7.requests.filter((request) =>
      request.pathname.endsWith("/recommendation-user-release/get-more")
    )
  ).toHaveLength(1)

  await expectInsideViewport(page, heading)
  await expectInsideViewport(page, page.getByRole("button", { name: "导出" }))
  await expectInsideViewport(page, page.getByRole("button", { name: "上一页" }))
  await expectNoPageOverflow(page)

  const overflowLabels = await page
    .locator("button, label, article")
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const html = element as HTMLElement
          return (
            html.offsetParent !== null &&
            html.scrollWidth > html.clientWidth + 1
          )
        })
        .map((element) => element.textContent?.trim())
        .filter(Boolean)
    )
  expect(overflowLabels).toEqual([])

  await page.evaluate(() => window.scrollTo(0, 0))
  const screenshot = await page.screenshot({
    path: testInfo.outputPath(
      `recommendation-feed-phase7-${testInfo.project.name}.png`
    ),
    fullPage: true,
  })
  await testInfo.attach(`recommendation-feed-phase7-${testInfo.project.name}`, {
    body: screenshot,
    contentType: "image/png",
  })

  const providerOrWorkflowRequests = [
    ...baseSession.capturedRequests,
    ...phase7.requests,
  ].filter((request) =>
    /recommendation-refill|discovery|contact-enrichment|provider|workflow/i.test(
      request.pathname
    )
  )
  expect(providerOrWorkflowRequests).toEqual([])
  expect(baseSession.unexpectedNetwork).toEqual([])
})
