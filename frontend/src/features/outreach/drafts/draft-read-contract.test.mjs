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
      "createdAt",
    ],
    "The current Draft version must include safe structured content."
  )
  assert.equal(
    currentVersion?.properties?.bodyDocument?.properties?.type?.enum?.[0],
    "doc"
  )
})
