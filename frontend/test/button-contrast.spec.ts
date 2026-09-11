import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

for (const theme of ["light", "dark"] as const) {
  test(`primary button stays readable when enabled and hovered in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    const session = await installOutreachApiFixtures(page)
    await page.emulateMedia({ colorScheme: theme })
    let releaseStatus!: () => void
    const statusReady = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    let statusRequests = 0
    await page.route("**/recommendation-user-release/status", async (route) => {
      // Let the project bootstrap finish, then hold the workspace's status load.
      if (++statusRequests > 1) await statusReady
      await route.fallback()
    })
    await page.goto(
      `/projects/${outreachFixture.projectKey}/backlinks/recommendations`
    )
    const button = page.getByRole("button", { name: "获取更多", exact: true })
    await expect(button).toBeDisabled()
    await button.evaluate((element) => {
      void getComputedStyle(element).opacity
      const observer = new MutationObserver(() => {
        if (!element.hasAttribute("disabled")) {
          element.setAttribute(
            "data-enabled-opacity",
            getComputedStyle(element).opacity
          )
          observer.disconnect()
        }
      })
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["disabled"],
      })
    })
    releaseStatus()
    await expect(button).toBeEnabled()
    await expect(button).toHaveAttribute("data-enabled-opacity", "1")

    for (const state of ["normal", "hover"] as const) {
      if (state === "hover") await button.hover()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .getAnimations()
                .filter(
                  (animation) =>
                    animation.playState === "running" &&
                    animation.effect?.getComputedTiming().iterations !==
                      Infinity
                ).length
          )
        )
        .toBe(0)
      const results = await new AxeBuilder({ page })
        .include("header")
        .withRules(["color-contrast"])
        .analyze()
      expect(results.violations).toEqual([])
      await page.screenshot({
        path: testInfo.outputPath(`${theme}-${state}.png`),
      })
    }
    await button.click()
    await expect(
      page.getByRole("button", { name: "暂无更多结果", exact: true })
    ).toBeDisabled()
    expect(
      session.capturedRequests.filter(
        (request) =>
          request.method === "POST" &&
          request.pathname.endsWith("/recommendation-user-release/get-more")
      )
    ).toHaveLength(1)
    expect(session.unexpectedNetwork).toEqual([])
  })

  test(`destructive button stays readable in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    const session = await installOutreachApiFixtures(page)
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(
      `/projects/${outreachFixture.projectKey}/backlinks/recommendations`
    )
    await page.getByRole("button", { name: "加入", exact: true }).click()
    await expect(
      page.getByText("已加入外链机会", { exact: true })
    ).toBeVisible()
    await page.getByRole("tab", { name: "外链机会", exact: true }).click()
    await page.getByRole("button", { name: "详情", exact: true }).click()
    const button = page.getByRole("button", { name: "撤销加入", exact: true })
    await expect(button).toBeEnabled()
    for (const state of ["normal", "hover"] as const) {
      if (state === "hover") await button.hover()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .getAnimations()
                .filter(
                  (animation) =>
                    animation.playState === "running" &&
                    animation.effect?.getComputedTiming().iterations !==
                      Infinity
                ).length
          )
        )
        .toBe(0)
      const results = await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .withRules(["color-contrast"])
        .analyze()
      expect(results.violations).toEqual([])
      await page.screenshot({
        path: testInfo.outputPath(`destructive-${theme}-${state}.png`),
      })
    }
    expect(session.unexpectedNetwork).toEqual([])
  })
}
