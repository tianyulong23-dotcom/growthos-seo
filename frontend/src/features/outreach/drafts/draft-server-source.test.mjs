import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (file) => readFile(path.join(dirname, file), "utf8")

test("BL-AI-184 uses generated Draft operations and backend evidence", async () => {
  const api = await read("api.ts")
  const generation = await read("draft-generation.tsx")
  const page = await read("draft-page.tsx")

  for (const operation of [
    "backlinksListOpportunityContactsV1",
    "backlinksCreateManualContactCandidateV1",
    "backlinksConfirmContactCandidateV1",
    "backlinksCreateDraftJobV1",
    "backlinksGetDraftJobV1",
    "backlinksGetLatestDraftJobV1",
    "backlinksGetDraftV1",
    "backlinksSaveDraftVersionV1",
    "backlinksApproveDraftV1",
    "backlinksGetSendIntentV1",
  ]) {
    assert.match(api, new RegExp(operation))
  }
  assert.doesNotMatch(api, /backlinksGetAssessmentV1/)
  assert.doesNotMatch(api, /evidenceSnapshotId:\s*string/)
  assert.match(generation, /created\.evidenceSnapshotId/)
  assert.match(generation, /getLatestDraftJob/)
  assert.match(generation, /pollIntervalMs = 1_500/)
  assert.match(generation, /searchParams\.get\("opportunityId"\)/)
  assert.match(
    generation,
    /`initial-outreach:\$\{opportunityId\}:\$\{selectedContact\.id\}`/
  )
  assert.match(generation, /requestKey\.current = null/)
  assert.match(generation, /\}, \[opportunityId, selectedContactId\]\)/)
  assert.doesNotMatch(generation, /setOpportunityId/)
  assert.match(page, /snapshot\.draftVersion/)
  assert.match(page, /getSendIntent/)
  assert.match(page, /terminalSendIntentStatuses/)
  assert.doesNotMatch(page, /features\/outreach\/api\/client/)
})

test("BL-AI-184 polls server states without Draft mock fallback", async () => {
  const generation = await read("draft-generation.tsx")
  const polling = await read("draft-job-polling.ts")
  const page = await read("draft-page.tsx")
  const parent = await read("../outreach-workspace.tsx")

  for (const state of ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "REFUSED"]) {
    assert.match(generation, new RegExp(`"${state}"`))
  }
  assert.match(generation, /getDraftJob/)
  assert.match(polling, /while \(!options\.signal\.aborted\)/)
  assert.match(polling, /window\.setTimeout/)
  assert.match(polling, /options\.getJob\(options\.signal\)/)
  assert.doesNotMatch(polling, /createDraftJob/)
  assert.match(generation, /controller\.abort\(\)/)
  assert.match(page, /draftId === "new"/)
  assert.doesNotMatch(`${generation}\n${page}\n${parent}`, /initialDrafts/)
  assert.doesNotMatch(`${generation}\n${page}`, /mock-data|fallback/i)
})

test("LP-FINAL requires explicit confirmation when an opportunity has no contact", async () => {
  const api = await read("api.ts")
  const generation = await read("draft-generation.tsx")

  assert.match(api, /createManualContactCandidate/)
  assert.match(api, /confirmContactCandidate/)
  assert.match(generation, /contacts\.length === 0/)
  assert.match(generation, /核对联系人/)
  assert.match(generation, /确认并保存联系人/)
  assert.match(generation, /pendingCandidate/)
  assert.doesNotMatch(generation, /example\.invalid|Canary 收件人|固定收件人/i)
})
