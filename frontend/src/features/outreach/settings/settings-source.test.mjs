import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (file) => readFile(path.join(dirname, file), "utf8")

test("BL-AI-171..178 settings use versioned server DTOs and ExpectedVersion", async () => {
  const api = await read("api.ts")
  const types = await read("types.ts")
  const workspace = await read("settings-workspace.tsx")

  assert.match(api, /from "@\/api\/client"/)
  assert.match(api, /\/backlinks\/settings/)
  assert.match(api, /expectedVersion/)
  assert.match(types, /editableKillSwitchLayers/)
  assert.match(types, /sourceLayer/)
  assert.match(types, /sourceVersion/)
  assert.match(workspace, /isSettingsApiStatus\(error, 403\)/)
  assert.match(workspace, /isSettingsApiStatus\(error, 409\)/)
})

test("settings show effective switch source, explicit confirmation, and read-only retention exceptions", async () => {
  const workspace = await read("settings-workspace.tsx")

  assert.match(workspace, /DataForSEO/)
  assert.match(workspace, /生效来源/)
  assert.match(workspace, /effectiveBlocked/)
  assert.match(workspace, /CONFIRM DANGEROUS CHANGE/)
  assert.match(workspace, /confirmation/)
  assert.match(workspace, /legal_hold/)
  assert.match(workspace, /audit_record/)
  assert.match(workspace, /active_suppression/)
  assert.match(workspace, /只选择到期记录，不在读取路径执行删除/)
  assert.doesNotMatch(workspace, /global.*option|organization.*option/i)
})

test("settings do not expose sensitive provider or message fields", async () => {
  const files = [
    await read("api.ts"),
    await read("types.ts"),
    await read("settings-workspace.tsx"),
  ].join("\n")

  assert.doesNotMatch(
    files,
    /accessToken|refreshToken|authorizationCode|providerPayload|emailAddress|emailBody/
  )
})
