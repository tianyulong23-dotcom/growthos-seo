import { expect, test } from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

const { projectKey, opportunityId } = outreachFixture
const domain = "publisher.example.test"

test("current work archive and restore stay server authoritative", async ({
  page,
}) => {
  const session = await installOutreachApiFixtures(page)

  await page.goto(`/projects/${projectKey}/backlinks/opportunities`)
  await expect(page.getByText(domain, { exact: true })).toBeVisible()
  await expect(
    page.getByText("editor@publisher.example.test", { exact: true })
  ).toBeVisible()

  await page.getByRole("button", { name: `管理 ${domain}` }).click()
  await page.getByRole("menuitem", { name: "撤销加入" }).click()
  await expect(
    page.getByRole("heading", { name: `撤销加入 ${domain}？` })
  ).toBeVisible()
  await page.getByRole("button", { name: "确认撤销加入" }).click()

  await expect(page.getByText(domain, { exact: true })).toHaveCount(0)
  await page.getByRole("combobox").nth(1).click()
  await page.getByRole("option", { name: "已归档" }).click()
  await expect(page.getByText(domain, { exact: true })).toBeVisible()

  await page.getByRole("button", { name: `管理 ${domain}` }).click()
  await page.getByRole("menuitem", { name: "恢复" }).click()
  await expect(
    page.getByRole("heading", { name: `恢复 ${domain}？` })
  ).toBeVisible()
  await page.getByRole("button", { name: "确认恢复" }).click()

  await expect(page.getByText(domain, { exact: true })).toHaveCount(0)
  await page.getByRole("combobox").nth(1).click()
  await page.getByRole("option", { name: "当前工作" }).click()
  await expect(page.getByText(domain, { exact: true })).toBeVisible()

  const managementRequests = session.capturedRequests.filter(
    (request) =>
      request.method === "PATCH" &&
      request.pathname.endsWith(
        `/opportunities/${opportunityId}/management`
      )
  )
  expect(managementRequests).toHaveLength(2)
  expect(managementRequests.map((request) => request.body)).toEqual([
    {
      expectedVersion: 3,
      managementStatus: "ARCHIVED",
      reason: "Opportunity join removed from current work.",
    },
    {
      expectedVersion: 4,
      managementStatus: "ACTIVE",
      reason: "Opportunity restored to active work.",
    },
  ])
  expect(managementRequests.every((request) => request.idempotencyKey)).toBe(
    true
  )
  expect(
    session.capturedRequests.some((request) => request.method === "DELETE")
  ).toBe(false)
  expect(session.unexpectedNetwork).toEqual([])
})
