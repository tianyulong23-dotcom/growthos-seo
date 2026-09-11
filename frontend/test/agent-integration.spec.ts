import { expect, test, type Page } from "@playwright/test"

import {
  installOutreachApiFixtures,
  outreachFixture,
} from "./support/outreach-api-fixtures"

const projectId = outreachFixture.projectKey
const conversationId = "agent-conversation-e2e"
const conversationPath = `/api/v1/projects/${projectId}/agent/conversations/${conversationId}`
const now = "2026-09-11T00:00:00Z"

function detail(streaming = false) {
  return {
    conversation: {
      id: conversationId,
      project_id: projectId,
      title: "Project assistant",
      created_at: now,
      updated_at: now,
    },
    messages: [],
    timeline: streaming
      ? []
      : [
          event(
            "onboarding:welcome",
            "message",
            "completed",
            "Welcome to your project.\n\nWe will review the website and prepare your business profile.",
            1
          ),
          {
            ...event(
              "onboarding:business-confirmation",
              "action",
              "waiting",
              "Confirm profile",
              2
            ),
            content: "Please review the business details.",
            action: {
              label: "Review profile",
              href: `/projects/${projectId}/settings/business`,
            },
          },
          {
            ...event(
              "onboarding:keywords",
              "task",
              "failed",
              "Prepare keywords",
              3
            ),
            content: "Keyword preparation failed.",
            metadata: {
              source: "onboarding",
              retryable: true,
              onboarding_step: "keywords",
            },
          },
        ],
    run: streaming
      ? {
          id: "stream-run",
          conversation_id: conversationId,
          status: "running",
          current_step: 1,
          error_code: null,
          error_message: null,
          action: null,
          final_message_id: null,
          steps: [],
          created_at: now,
          updated_at: now,
        }
      : null,
    action: null,
  }
}

function event(
  key: string,
  kind: string,
  status: string,
  title: string,
  sequence: number
) {
  return {
    id: key,
    event_key: key,
    conversation_id: conversationId,
    sequence,
    kind,
    status,
    title,
    content: "",
    action: {},
    metadata: { source: "onboarding" },
    created_at: now,
    updated_at: now,
  }
}

async function openAgent(page: Page) {
  await page.goto(`/projects/${projectId}/backlinks/recommendations`)
  const mobileButton = page.getByRole("button", { name: "打开 AI Agent" })
  if (await mobileButton.isVisible()) {
    await mobileButton.click()
    return page.getByRole("dialog", { name: "AI Agent", exact: true })
  }
  return page
    .locator("aside")
    .filter({ has: page.getByRole("button", { name: "对话操作" }) })
}

test("persisted welcome, profile action, and retry remain usable", async ({
  page,
}, testInfo) => {
  const session = await installOutreachApiFixtures(page)
  let retries = 0
  await page.route(`**${conversationPath}`, (route) =>
    route.fulfill({ json: detail() })
  )
  await page.route(`**/onboarding/steps/keywords/retry`, (route) => {
    retries += 1
    return route.fulfill({
      status: retries === 1 ? 503 : 200,
      json: retries === 1 ? { detail: "Temporary retry failure" } : {},
    })
  })
  const agent = await openAgent(page)
  const welcome = agent.getByText("Welcome to your project.", { exact: true })
  await expect(welcome).toBeVisible()
  expect(await welcome.evaluate((element) => element.tagName)).toBe("P")
  expect(
    await welcome.evaluate((element) => element.closest('[data-slot="badge"]'))
  ).toBeNull()
  await expect(
    agent.getByText(
      "We will review the website and prepare your business profile."
    )
  ).toBeVisible()
  await expect(
    agent.getByRole("button", { name: "Review profile" })
  ).toBeVisible()
  const retry = agent.getByRole("button", { name: "重试任务" })
  await retry.click()
  await expect(agent.getByText("Temporary retry failure")).toBeVisible()
  await retry.click()
  await expect(agent.getByText("Temporary retry failure")).toBeHidden()
  expect(retries).toBe(2)
  await page.screenshot({ path: testInfo.outputPath("agent-onboarding.png") })
  await agent.getByRole("button", { name: "Review profile" }).click()
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectId}/settings/business$`)
  )
  expect(session.unexpectedNetwork).toEqual([])
})

test("successive stream deltas follow the bottom but preserve manual scroll-away", async ({
  page,
}, testInfo) => {
  const session = await installOutreachApiFixtures(page)
  // Exercise the production EventSource adapter while delivering deterministic events.
  await page.addInitScript(() => {
    const sources: EventTarget[] = []
    class TestEventSource extends EventTarget {
      constructor() {
        super()
        sources.push(this)
      }
      close() {
        sources.splice(sources.indexOf(this), 1)
      }
    }
    Object.assign(window, {
      EventSource: TestEventSource,
      agentStreamReady: () => sources.length > 0,
      emitAgentEvent: (payload: Record<string, unknown>) => {
        for (const source of sources) {
          source.dispatchEvent(
            new MessageEvent("message_update", {
              data: JSON.stringify(payload),
            })
          )
        }
      },
    })
  })
  await page.route(`**${conversationPath}`, (route) =>
    route.fulfill({ json: detail(true) })
  )
  const agent = await openAgent(page)
  const marker = agent.getByText("Stream paragraph 0.", { exact: true })
  let sequence = 0
  async function delta(text: string) {
    sequence += 1
    await page.evaluate(
      (payload) => {
        const target = window as unknown as {
          emitAgentEvent: (value: unknown) => void
        }
        target.emitAgentEvent(payload)
      },
      {
        conversation_id: conversationId,
        project_id: projectId,
        run_id: "stream-run",
        message_id: "stream-message",
        phase: "final",
        round: 1,
        attempt: 1,
        sequence,
        event_key: `stream-${sequence}`,
        assistant_message_event: { kind: "text_delta", delta: text },
      }
    )
  }
  await expect(agent.getByLabel("Agent 正在输入").first()).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { agentStreamReady: () => boolean }
        ).agentStreamReady()
      )
    )
    .toBe(true)
  await delta(
    Array.from({ length: 45 }, (_, index) => `Stream paragraph ${index}.`).join(
      "\n\n"
    )
  )
  await expect(marker).toBeAttached()
  const viewport = marker.locator(
    "xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]"
  )
  const gap = () =>
    viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
  await expect.poll(gap).toBeLessThan(3)
  await delta("\n\nSuccessive reply one.\n\nSuccessive reply two.")
  await expect(
    agent.getByText("Successive reply two.", { exact: true })
  ).toBeVisible()
  await expect.poll(gap).toBeLessThan(3)
  await viewport.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event("scroll"))
  })
  await delta("\n\nReply while reading history.")
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0)
  await viewport.evaluate((el) => {
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event("scroll"))
  })
  await delta("\n\nReply after returning to bottom.")
  await expect.poll(gap).toBeLessThan(3)
  await page.screenshot({
    path: testInfo.outputPath("agent-stream-bottom.png"),
  })
  expect(session.unexpectedNetwork).toEqual([])
})
