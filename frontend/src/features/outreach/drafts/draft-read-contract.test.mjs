import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const openApiPath = path.resolve(
  dirname,
  "../../../../../backend/contracts/openapi/backlinks.v1.json"
)
const openApi = JSON.parse(readFileSync(openApiPath, "utf8"))

const draftReadPath =
  "/api/v1/projects/{websiteProjectKey}/backlinks/drafts/{draftId}"
const sendIntentListPath =
  "/api/v1/projects/{websiteProjectKey}/backlinks/send-intents"

test("BL-AI-097 can reload an editable Draft snapshot from the backend", () => {
  const draftRead = openApi.paths[draftReadPath]?.get
  assert.ok(draftRead, `Missing GET ${draftReadPath}.`)

  const responseSchema =
    draftRead.responses?.["200"]?.content?.["application/json"]?.schema
  const draftSchema = responseSchema?.properties?.draft
  const draftRequired = draftSchema?.required ?? []
  assert.deepEqual(
    draftRequired,
    [
      "id",
      "opportunityId",
      "contactId",
      "contactVersion",
      "status",
      "draftVersion",
      "approvedVersionId",
      "inputSnapshot",
      "freshness",
      "currentVersion",
    ],
    "Draft reads must expose the bound Contact and backend versions."
  )

  const currentVersion = draftSchema?.properties?.currentVersion
  assert.deepEqual(
    currentVersion?.required,
    [
      "id",
      "versionNo",
      "subjectText",
      "bodyText",
      "bodyDocument",
      "source",
      "readiness",
      "fallbackReason",
      "createdAt",
    ],
    "The current Draft version must include safe structured content."
  )
  assert.equal(
    currentVersion?.properties?.bodyDocument?.properties?.type?.enum?.[0],
    "doc"
  )
  assert.deepEqual(currentVersion?.properties?.readiness?.enum, [
    "AI_DRAFT_READY",
    "BASIC_DRAFT_READY",
    "EDITED_DRAFT_READY",
  ])
  assert.deepEqual(
    draftSchema?.properties?.freshness?.properties?.state?.enum,
    ["FRESH", "STALE", "UNKNOWN"]
  )
  assert.deepEqual(
    draftSchema?.properties?.freshness?.properties?.staleReasons?.items?.enum,
    ["PROJECT_CONTEXT_CHANGED", "OPPORTUNITY_CHANGED", "CONTACT_CHANGED"]
  )
  assert.ok(
    draftSchema?.properties?.inputSnapshot?.properties?.request,
    "Draft reads must expose the immutable generation request."
  )
})

test("Send Intent reads can restore the latest status for one Draft", () => {
  const sendIntentList = openApi.paths[sendIntentListPath]?.get
  assert.ok(sendIntentList, `Missing GET ${sendIntentListPath}.`)

  const queryNames = sendIntentList.parameters
    .filter((parameter) => parameter.in === "query")
    .map((parameter) => parameter.name)
  assert.ok(queryNames.includes("draftId"))

  const responseSchema =
    sendIntentList.responses?.["200"]?.content?.["application/json"]?.schema
  const itemSchema = responseSchema?.properties?.items?.items
  const diagnostics = itemSchema?.properties?.diagnostics
  assert.ok(diagnostics?.properties?.resubmittable)
  assert.ok(
    diagnostics?.properties?.primaryNextAction?.enum?.includes(
      "RECHECK_BEFORE_RESUBMIT"
    )
  )
})
