import assert from "node:assert/strict"
import test from "node:test"

import {
  isRecommendationRefillActive,
  pollRecommendationRefill,
  recommendationContactBatchActivity,
  recommendationRefillPollDelaysMs,
} from "./recommendation-refill-polling.ts"

const snapshot = (overrides = {}) => ({
  operationId: "operation-037",
  stage: "discovery",
  terminal: false,
  terminalState: null,
  publishedCount: 4,
  refillInFlight: true,
  refillState: "running",
  serverUpdatedAt: "2026-08-10T02:00:00.000Z",
  refillJob: {
    id: "refill-job-032",
    status: "running",
    progress: 5,
    updatedAt: "2026-08-10T02:00:00.000Z",
  },
  contactBatch: null,
  ...overrides,
})

test("LOCAL-PRODUCT-032 keeps one server batch alive beyond 60 seconds", async () => {
  const responses = [
    snapshot(),
    snapshot(),
    snapshot({
      terminal: true,
      terminalState: "TARGET_REACHED",
      stage: "complete",
      publishedCount: 10,
      refillInFlight: false,
      refillState: "completed",
      serverUpdatedAt: "2026-08-10T02:02:05.000Z",
      refillJob: {
        id: "refill-job-032",
        status: "success",
        progress: 100,
        updatedAt: "2026-08-10T02:02:05.000Z",
      },
      contactBatch: {
        id: "contact-batch-032",
        status: "completed",
        totalJobCount: 2,
        terminalJobCount: 2,
        nextRetryAt: null,
        startedAt: "2026-08-10T02:00:00.000Z",
      },
    }),
  ]
  const delays = []
  let inFlight = 0
  let maxInFlight = 0
  let terminalCalls = 0

  const reason = await pollRecommendationRefill({
    signal: new AbortController().signal,
    sleep: async (delay) => {
      delays.push(delay)
      return true
    },
    getInventory: async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const next = responses.shift()
      inFlight -= 1
      assert.ok(next)
      return next
    },
    onInventory: () => undefined,
    shouldContinue: isRecommendationRefillActive,
    onTerminal: () => {
      terminalCalls += 1
    },
  })

  assert.equal(reason, "terminal")
  assert.equal(maxInFlight, 1)
  assert.equal(terminalCalls, 1)
  assert.deepEqual(delays, [1_500, 2_500])
})

test("STAGE2Q stops high-frequency polling after eight consecutive read errors", async () => {
  const delays = []
  let calls = 0

  const reason = await pollRecommendationRefill({
    signal: new AbortController().signal,
    sleep: async (delay) => {
      delays.push(delay)
      return true
    },
    getInventory: async () => {
      calls += 1
      throw new Error("temporary read failure")
    },
    onInventory: () => undefined,
    shouldContinue: () => true,
    onTerminal: () => undefined,
  })

  assert.equal(reason, "background")
  assert.equal(calls, 8)
  assert.equal(Math.max(...delays), 15_000)
  assert.equal(delays.at(-1), recommendationRefillPollDelaysMs.at(-1))
})

test("STAGE2Q stops active polling after two minutes while the server continues", async () => {
  let now = 0
  let calls = 0

  const reason = await pollRecommendationRefill({
    signal: new AbortController().signal,
    now: () => now,
    sleep: async (delay) => {
      now += delay
      return true
    },
    getInventory: async () => {
      calls += 1
      return snapshot()
    },
    onInventory: () => undefined,
    shouldContinue: () => true,
    onTerminal: () => undefined,
  })

  assert.equal(reason, "background")
  assert.ok(now >= 120_000)
  assert.ok(calls > 1)
})

test("LOCAL-PRODUCT-032 does not keep recommendation refill active for contact processing", () => {
  assert.equal(
    isRecommendationRefillActive(
      snapshot({
        refillInFlight: false,
        refillState: "completed",
        refillJob: {
          id: "refill-job-032",
          status: "success",
          progress: 100,
          updatedAt: "2026-08-10T02:00:30.000Z",
        },
        contactBatch: {
          id: "contact-batch-032",
          status: "running",
          totalJobCount: 4,
          terminalJobCount: 1,
          nextRetryAt: null,
          startedAt: "2026-08-10T02:00:00.000Z",
        },
      }),
      Date.parse("2026-08-10T02:01:00.000Z")
    ),
    false
  )
})

test("LOCAL-PRODUCT-038 keeps a future scheduled contact retry connected", () => {
  const now = Date.parse("2026-08-12T02:00:00.000Z")
  const inventory = snapshot({
    stage: "contact",
    refillInFlight: false,
    refillState: "completed",
    refillJob: {
      id: "refill-job-038",
      status: "success",
      progress: 100,
      updatedAt: "2026-08-12T01:55:00.000Z",
    },
    contactBatch: {
      id: "contact-batch-038",
      status: "running",
      totalJobCount: 30,
      terminalJobCount: 25,
      nextRetryAt: "2026-08-12T02:05:00.000Z",
      startedAt: "2026-08-12T01:00:00.000Z",
    },
  })
  assert.equal(
    recommendationContactBatchActivity(inventory, now),
    "waiting_retry"
  )
  assert.equal(isRecommendationRefillActive(inventory, now), false)
})

test("LOCAL-PRODUCT-038 keeps paused operations non-active without losing the operation", () => {
  assert.equal(
    isRecommendationRefillActive(
      snapshot({
        stage: "pause",
        terminal: false,
        terminalState: "PAUSED_BUDGET",
        refillInFlight: false,
        refillState: "paused",
        refillJob: {
          id: "refill-job-037",
          status: "partial_success",
          progress: 80,
          updatedAt: "2026-08-11T02:00:00.000Z",
        },
      })
    ),
    false
  )
})

test("LOCAL-PRODUCT-037 stops only on an explicit terminal state", () => {
  assert.equal(
    isRecommendationRefillActive(
      snapshot({
        terminal: true,
        terminalState: "SUPPLY_FLOOR_REACHED",
        stage: "complete",
        refillInFlight: false,
        refillState: "exhausted",
      })
    ),
    false
  )
})

test("LOCAL-PRODUCT-038 keeps an independently running refill active despite stale contact work", () => {
  const now = Date.parse("2026-08-12T02:00:00.000Z")
  const inventory = snapshot({
    stage: "contact",
    refillInFlight: true,
    refillState: "running",
    serverUpdatedAt: "2026-08-11T05:42:24.625Z",
    refillJob: {
      id: "refill-job-038",
      status: "running",
      progress: 60,
      updatedAt: "2026-08-12T01:59:30.000Z",
    },
    contactBatch: {
      id: "contact-batch-038",
      status: "running",
      totalJobCount: 30,
      terminalJobCount: 25,
      nextRetryAt: "2026-08-11T05:42:24.625Z",
      startedAt: "2026-08-06T09:01:00.000Z",
    },
  })
  assert.equal(
    recommendationContactBatchActivity(inventory, now),
    "recovery_required"
  )
  assert.equal(isRecommendationRefillActive(inventory, now), true)
})

test("LOCAL-PRODUCT-038 does not treat a stale operation id as live work", () => {
  const now = Date.parse("2026-08-12T02:00:00.000Z")
  const inventory = snapshot({
    operationId: "operation-stale-038",
    stage: "discovery",
    refillInFlight: true,
    refillState: "running",
    serverUpdatedAt: "2026-08-11T05:42:24.625Z",
    refillJob: {
      id: "refill-job-stale-038",
      status: "success",
      progress: 100,
      updatedAt: "2026-08-11T05:42:24.625Z",
    },
    contactBatch: null,
  })

  assert.equal(isRecommendationRefillActive(inventory, now), false)
})

test("Phase 5 discards a late inventory response after a project switch", async () => {
  const controller = new AbortController()
  let resolveInventory
  let inventoryCalls = 0
  let terminalCalls = 0
  const inventoryPromise = new Promise((resolve) => {
    resolveInventory = resolve
  })

  const polling = pollRecommendationRefill({
    signal: controller.signal,
    getInventory: async () => inventoryPromise,
    onInventory: () => {
      inventoryCalls += 1
    },
    shouldContinue: () => false,
    onTerminal: () => {
      terminalCalls += 1
    },
  })

  controller.abort()
  resolveInventory(snapshot())

  assert.equal(await polling, "aborted")
  assert.equal(inventoryCalls, 0)
  assert.equal(terminalCalls, 0)
})
