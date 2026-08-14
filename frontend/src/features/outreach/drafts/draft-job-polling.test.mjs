import assert from "node:assert/strict"
import test from "node:test"

import { pollDraftJob } from "./draft-job-polling.ts"

const runningJob = (status) => ({
  id: "draft-job-010",
  draftId: "draft-010",
  status,
  deadlineAt: "2026-08-05T04:02:00.000Z",
})

test("LOCAL-PRODUCT-018 keeps polling the same Job across running and retry states", async () => {
  const responses = [
    runningJob("RUNNING"),
    runningJob("RETRY_SCHEDULED"),
    runningJob("SUCCEEDED"),
  ]
  let calls = 0
  let inFlight = 0
  let maxInFlight = 0
  const seen = []

  const result = await pollDraftJob({
    signal: new AbortController().signal,
    intervalMs: 1_500,
    now: () => Date.parse("2026-08-05T04:01:00.000Z"),
    sleep: async () => true,
    getJob: async () => {
      calls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const job = responses.shift()
      inFlight -= 1
      assert.ok(job)
      return job
    },
    onJob: (job) => seen.push(job.status),
  })

  assert.equal(result.reason, "terminal")
  assert.equal(result.job?.draftId, "draft-010")
  assert.equal(calls, 3)
  assert.equal(maxInFlight, 1)
  assert.deepEqual(seen, ["RUNNING", "RETRY_SCHEDULED", "SUCCEEDED"])
})

test("LOCAL-PRODUCT-010 stops polling when the request scope is aborted", async () => {
  const controller = new AbortController()
  let calls = 0

  const result = await pollDraftJob({
    signal: controller.signal,
    intervalMs: 1_500,
    sleep: async () => {
      controller.abort()
      return false
    },
    getJob: async () => {
      calls += 1
      return runningJob("RUNNING")
    },
    onJob: () => undefined,
  })

  assert.equal(result.reason, "aborted")
  assert.equal(calls, 0)
})

test("LOCAL-PRODUCT-010 stops automatically after the server deadline", async () => {
  let calls = 0
  const result = await pollDraftJob({
    signal: new AbortController().signal,
    intervalMs: 1_500,
    now: () => Date.parse("2026-08-05T04:03:00.000Z"),
    sleep: async () => true,
    getJob: async () => {
      calls += 1
      return runningJob("RUNNING")
    },
    onJob: () => undefined,
  })

  assert.equal(result.reason, "stale")
  assert.equal(calls, 1)
})
