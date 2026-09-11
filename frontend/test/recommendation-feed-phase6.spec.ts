import { expect, test, type Page, type Route } from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

const { projectKey } = outreachFixture
const itemId = "018f0000-0000-7000-8000-000000000601"
const generationId = "018f0000-0000-7000-8000-000000000602"
const seedFingerprint = "d".repeat(64)
const generatedAt = "2026-09-04T04:00:00.000Z"

type CapturedRequest = {
  method: string
  pathname: string
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

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  })
}

function preparedSeed(
  kind: "KEYWORD" | "CATEGORY" | "SEO_COMPETITOR",
  rawValue: string,
  fingerprintCharacter: string
) {
  return {
    kind,
    rawValue,
    normalizedValue: rawValue.toLowerCase(),
    source: "USER_TRIGGERED_GENERATION",
    validationStatus: "VERIFIED",
    validationReasonCodes: [],
    evidenceRefs: [
      {
        evidenceType: "PROJECT_CONTEXT",
        recordId: projectKey,
        field: "keywords",
      },
    ],
    confidenceBand: "HIGH",
    seedFingerprint: fingerprintCharacter.repeat(64),
    supersedesSeedId: null,
  }
}

async function installGate6Fixtures(page: Page) {
  const requests: CapturedRequest[] = []
  let staged = false
  let launched = false
  let launchedFeedReads = 0

  await page.route(
    `**/api/v1/projects/${projectKey}/backlinks/**`,
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const method = request.method()
      const pathname = url.pathname
      const isGate6Path =
        pathname.endsWith("/backlinks/recommendation-feed") ||
        pathname.endsWith("/backlinks/recommendation-user-release/status") ||
        pathname.includes("/backlinks/recommendation-seeds/")
      if (!isGate6Path) {
        return route.fallback()
      }

      requests.push({
        method,
        pathname,
        body: request.postData() ? request.postDataJSON() : null,
      })

      if (
        method === "GET" &&
        pathname.endsWith("/backlinks/recommendation-feed")
      ) {
        if (launched) launchedFeedReads += 1
        const terminal = launched && launchedFeedReads >= 2
        return json(route, {
          items: [
            {
              itemId,
              domain: "historical.publisher.example",
              displayUrl: "https://historical.publisher.example/",
              recommended: true,
              reasons: ["RELEVANT_CATEGORY"],
              category: "Editorial",
              metrics: {
                targetMarketOrganicTraffic: null,
                dataForSeoRank: null,
                spamScore: null,
              },
              contact: {
                email: null,
                contactPage: "https://historical.publisher.example/contact",
                outcome: "CONTACT_PAGE_FOUND",
              },
              opportunity: {
                opportunityId: null,
                businessStage: null,
                managementStatus: null,
                outcomeStatus: null,
                createdByCurrentUser: false,
              },
              archived: false,
              releasedAt: "2026-09-01T01:00:00.000Z",
            },
          ],
          releasedPool: {
            generationCount: 1,
            oldestVisiblePoolGeneration: 1,
            newestVisiblePoolGeneration: 1,
          },
          latestGeneration: {
            generationContractId: staged ? generationId : itemId,
            visiblePoolGeneration: staged ? 2 : 1,
            jobState: terminal
              ? "PARTIAL_SUCCESS"
              : launched
                ? "RUNNING"
                : staged
                  ? "PENDING_LAUNCH"
                  : "SUCCESS",
            progress: terminal ? 100 : launched ? 45 : staged ? 0 : 100,
            discoveryResult: terminal
              ? "PARTIAL_EXHAUSTED"
              : launched
                ? "IN_PROGRESS"
                : staged
                  ? "PENDING"
                  : "COMPLETED",
            contactPreparation: terminal
              ? "COMPLETED_PARTIAL"
              : launched
                ? "PENDING"
                : staged
                  ? "PENDING"
                  : "COMPLETED",
            releaseResult: terminal
              ? "RELEASED"
              : launched || staged
                ? "PENDING"
                : "RELEASED",
            effectiveUniqueCandidateCount: terminal ? 7 : launched ? 3 : 12,
            admittedCount: terminal ? 5 : 0,
            releasedCount: terminal ? 5 : staged || launched ? 0 : 1,
            terminalReason: terminal ? "PARTIAL_EXHAUSTED" : null,
            retrySafe: false,
          },
          totalCount: 1,
          nextCursor: null,
          meta: meta("backlinks.recommendation-feed.v2", "gate6-feed"),
        })
      }

      if (
        method === "GET" &&
        pathname.endsWith("/backlinks/recommendation-user-release/status")
      ) {
        return json(route, {
          state: "PUBLISHED",
          currentBatchOrdinal: 1,
          requiredOpportunityCount: 1,
          successfulOpportunityCount: 0,
          unlockAt: "2026-09-04T22:00:00.000Z",
          unlockReason: "ELAPSED_18H",
          canGetMore: false,
          getMoreState: "NOT_UNLOCKED",
          meta: meta(
            "backlinks.recommendation-user-release.v2",
            "gate6-status"
          ),
        })
      }

      if (
        method === "POST" &&
        pathname.endsWith("/backlinks/recommendation-seeds/validate")
      ) {
        const submitted =
          (request.postDataJSON() as { seeds?: Array<{ value: string }> })
            .seeds ?? []
        const keyword =
          submitted.find((seed) => seed.value.includes("outreach"))?.value ??
          "email outreach"
        const seeds = [
          preparedSeed("KEYWORD", keyword, "a"),
          preparedSeed("CATEGORY", "SaaS", "b"),
          preparedSeed("SEO_COMPETITOR", "competitor.example", "c"),
        ]
        return json(route, {
          state: "READY",
          reasonCodes: [],
          seeds,
          blueprintSeedReferences: seeds.map((seed, index) => ({
            seedFingerprint: seed.seedFingerprint,
            seedOrdinal: index + 1,
          })),
          meta: meta("backlinks.recommendation-seeds.v2", "gate6-preview"),
        })
      }

      if (
        method === "POST" &&
        pathname.endsWith("/backlinks/recommendation-seeds/generate")
      ) {
        staged = true
        const seeds =
          (
            request.postDataJSON() as {
              seeds: Array<{
                kind: "KEYWORD" | "CATEGORY" | "SEO_COMPETITOR"
                value: string
              }>
            }
          ).seeds ?? []
        const persistedSeeds = seeds.map((seed, index) => ({
          ...preparedSeed(seed.kind, seed.value, String(index + 1)),
          id: `018f0000-0000-7000-8000-${String(index + 610).padStart(12, "0")}`,
        }))
        return json(route, {
          state: "READY",
          replayed: false,
          reasonCodes: [],
          confirmation: {
            generationContractId: generationId,
            seedSnapshotFingerprint: seedFingerprint,
          },
          snapshot: {
            projectContextSnapshotId: "018f0000-0000-7000-8000-000000000620",
            projectContextSnapshotVersion: 1,
            canonicalDomain: "owner.example.test",
            locale: "en-US",
            countryCode: "US",
            siteProfileVersionId: "site-profile-e2e",
            outreachProfileVersionId: "outreach-profile-e2e",
            outreachProfileFingerprint: "e".repeat(64),
            promotionTargetVersionId: "promotion-e2e",
            market: "US",
            location: "United States",
            language: "en",
            keywords: seeds
              .filter((seed) => seed.kind === "KEYWORD")
              .map((seed) => seed.value),
            categories: seeds
              .filter((seed) => seed.kind === "CATEGORY")
              .map((seed) => seed.value),
            products: [],
            targetAudiences: [],
            seoCompetitors: seeds
              .filter((seed) => seed.kind === "SEO_COMPETITOR")
              .map((seed) => seed.value),
          },
          seeds: persistedSeeds,
          blueprintSeedReferences: persistedSeeds.map((seed, index) => ({
            id: `018f0000-0000-7000-8000-${String(index + 630).padStart(12, "0")}`,
            blueprintId: "018f0000-0000-7000-8000-000000000640",
            seedId: seed.id,
            seedFingerprint: seed.seedFingerprint,
            seedOrdinal: index + 1,
          })),
          meta: meta("backlinks.recommendation-seeds.v2", "gate6-confirm"),
        })
      }

      if (
        method === "POST" &&
        pathname.endsWith("/backlinks/recommendation-seeds/launch")
      ) {
        launched = true
        return json(route, {
          generationContractId: generationId,
          visiblePoolGeneration: 2,
          jobId: "018f0000-0000-7000-8000-000000000650",
          workflowId: "recommendation-pool-v2-gate6-e2e",
          state: "STARTED",
          replayed: false,
          meta: meta("backlinks.recommendation-seeds.v2", "gate6-launch"),
        })
      }

      return json(route, { detail: "Unexpected Gate 6 request" }, 501)
    }
  )

  return { requests }
}

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1)
}

test("Gate 6 keeps the released pool usable through explicit seed confirmation and terminal polling", async ({
  page,
}, testInfo) => {
  const baseSession = await installOutreachApiFixtures(page)
  const gate6 = await installGate6Fixtures(page)

  await page.goto(`/projects/${projectKey}/backlinks/recommendations`)

  await expect(page.getByText("最新生成 · 第 1 轮")).toBeVisible()
  await expect(page.getByText("第 1 轮", { exact: true })).toBeVisible()
  const historicalLink = page.getByRole("link", {
    name: "historical.publisher.example",
    exact: true,
  })
  await expect(historicalLink).toBeVisible()

  await page.getByRole("button", { name: "新建推荐池", exact: true }).click()
  const prepareButton = page.getByRole("button", {
    name: "准备建议种子",
  })
  await prepareButton.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByLabel("种子内容 1")).toHaveValue("email outreach")
  await expect(page.getByLabel("种子内容 2")).toHaveValue("SaaS")
  await expect(page.getByLabel("种子内容 3")).toHaveValue("competitor.example")

  await page.getByLabel("种子内容 1").fill("email outreach software")
  await expect(page.getByRole("button", { name: "确认种子" })).toBeDisabled()
  await prepareButton.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByLabel("种子内容 1")).toHaveValue(
    "email outreach software"
  )

  const confirmButton = page.getByRole("button", { name: "确认种子" })
  await confirmButton.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("快照已确认", { exact: true })).toBeVisible()

  const confirmRequest = gate6.requests.find((request) =>
    request.pathname.endsWith("/recommendation-seeds/generate")
  )
  expect(confirmRequest?.body).toEqual({
    seeds: [
      { kind: "KEYWORD", value: "email outreach software" },
      { kind: "CATEGORY", value: "SaaS" },
      { kind: "SEO_COMPETITOR", value: "competitor.example" },
    ],
  })

  const launchButton = page.getByRole("button", {
    name: "生成新推荐池",
  })
  await launchButton.focus()
  await page.keyboard.press("Enter")
  await expect(historicalLink).toBeVisible()
  await expect(page.getByText("最新生成 · 第 2 轮")).toBeVisible()
  await expect(page.getByText("本轮检索已结束，已保留可用推荐")).toBeVisible({
    timeout: 10_000,
  })

  const launchRequest = gate6.requests.find((request) =>
    request.pathname.endsWith("/recommendation-seeds/launch")
  )
  expect(launchRequest?.body).toEqual({
    generationContractId: generationId,
    seedSnapshotFingerprint: seedFingerprint,
  })
  const implicitEmptyConfirmations = gate6.requests.filter(
    (request) =>
      request.pathname.endsWith("/recommendation-seeds/generate") &&
      JSON.stringify(request.body) === JSON.stringify({ seeds: [] })
  )
  expect(implicitEmptyConfirmations).toEqual([])

  await expectNoPageOverflow(page)
  const screenshot = await page.screenshot({
    path: testInfo.outputPath(
      `recommendation-feed-phase6-${testInfo.project.name}.png`
    ),
    fullPage: true,
  })
  await testInfo.attach(`recommendation-feed-phase6-${testInfo.project.name}`, {
    body: screenshot,
    contentType: "image/png",
  })

  const externalProviderRequests = [
    ...baseSession.capturedRequests,
    ...gate6.requests,
  ].filter((request) =>
    /dataforseo|provider|contact-enrichment/i.test(request.pathname)
  )
  expect(externalProviderRequests).toEqual([])
  expect(baseSession.unexpectedNetwork).toEqual([])
})
