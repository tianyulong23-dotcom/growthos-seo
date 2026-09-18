import { expect, test } from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

const { projectKey, opportunityId, now } = outreachFixture

for (const scenario of [
  { stage: "JOINED", path: "EMAIL_READY", pending: 0, ready: 1 },
  { stage: "READY_TO_CONTACT", path: "CONTACT_PENDING", pending: 1, ready: 0 },
  { stage: "JOINED", path: "MANUAL_PATH_READY", pending: 0, ready: 0 },
  { stage: "READY_TO_CONTACT", path: null, pending: 0, ready: 0 },
]) {
  test(`contact summary follows path ${scenario.path}, not stage ${scenario.stage}`, async ({
    page,
  }) => {
    const session = await installOutreachApiFixtures(page)
    await page.route("**/backlinks/opportunities?**", async (route) => {
      await route.fulfill({
        json: {
          items: [
            {
              id: opportunityId,
              targetSiteKey: "publisher.example.test",
              targetHostAscii: "publisher.example.test",
              joinSequence: 1,
              businessStage: scenario.stage,
              managementStatus: "ACTIVE",
              outcomeStatus: "OPEN",
              fulfillmentStatus: "NOT_EXPECTED",
              engagementChannel: "EMAIL",
              engagementPathState: scenario.path,
              contactEmail: null,
              contactReviewRequired: false,
              hasDownstreamFacts: false,
              version: 3,
              createdAt: now,
              updatedAt: now,
            },
          ],
          nextCursor: "another-page",
          hasMore: true,
          meta: {
            organizationId: "organization-e2e",
            workspaceId: "workspace-e2e",
            websiteProjectId: projectKey,
            requestId: "readiness-e2e",
            schemaVersion: "backlinks.v1",
            generatedAt: now,
          },
        },
      })
    })
    await page.goto(`/projects/${projectKey}/backlinks/opportunities`)
    await expect(
      page.getByText("publisher.example.test", { exact: true })
    ).toBeVisible()
    for (const [label, count] of [
      ["待补联系人", scenario.pending],
      ["邮件联系人就绪", scenario.ready],
    ] as const) {
      const summary = page.locator('[data-slot="card"]').filter({
        has: page.getByText(label, { exact: true }),
      })
      await expect(summary.locator(".text-2xl")).toHaveText(String(count))
      await expect(summary.getByText("当前列表", { exact: true })).toBeVisible()
    }
    expect(
      session.capturedRequests.some((request) => request.method !== "GET")
    ).toBe(false)
    expect(session.unexpectedNetwork).toEqual([])
  })
}
