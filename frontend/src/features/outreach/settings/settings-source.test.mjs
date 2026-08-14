import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (file) => readFile(path.join(dirname, file), "utf8")

test("BL-AI-188 settings use generated versioned governance operations", async () => {
  const api = await read("api.ts")
  const types = await read("types.ts")
  const workspace = await read("settings-workspace.tsx")

  assert.match(api, /requestBacklinks/)
  assert.match(api, /backlinksGetSettingsGovernanceV1/)
  assert.match(api, /backlinksUpdateSettingsV1/)
  assert.match(api, /backlinksUpdateKillSwitchV1/)
  assert.doesNotMatch(api, /from "@\/api\/client".*apiRequest|\/api\/v1/)
  assert.match(types, /BacklinksResponse/)
  assert.match(types, /BacklinksRequest/)
  assert.match(workspace, /expectedVersion: view\.settings\.version/)
  assert.match(
    workspace,
    /expectedVersion: selectedSwitch\.sourceVersion \?\? 0/
  )
  assert.match(workspace, /backlinksProjectQueries\.fetch/)
  assert.match(workspace, /createProjectQueryKey/)
  assert.match(workspace, /AbortError/)
  assert.match(workspace, /ExpectedVersion/)
})

test("effective sources stay read-only unless the server authorizes their layer", async () => {
  const workspace = await read("settings-workspace.tsx")

  assert.match(workspace, /生效来源/)
  assert.match(workspace, /effectiveBlocked/)
  assert.match(workspace, /selectedSwitch\.editable/)
  assert.match(workspace, /editableLayersForSwitch/)
  assert.match(workspace, /editableKillSwitchLayers\.filter/)
  assert.match(workspace, /layer === "project" \|\| item\.provider !== null/)
  assert.match(workspace, /!editableLayers\.includes\(selectedLayer\)/)
  assert.match(
    workspace,
    /selectedLayer === "provider" \? selectedSwitch\.provider : null/
  )
  assert.doesNotMatch(workspace, /selectedSwitch\.provider \?\? "DataForSEO"/)
  assert.match(
    workspace,
    /不会提供 global、[\s\S]*organization 或 workspace 层修改入口/
  )
  assert.doesNotMatch(
    workspace,
    /SelectItem[^>]+value="(?:global|organization|workspace)"/
  )
})

test("dangerous changes require exact confirmation and a reason", async () => {
  const workspace = await read("settings-workspace.tsx")

  assert.match(workspace, /CONFIRM DANGEROUS CHANGE/)
  assert.match(workspace, /confirmation !== DANGEROUS_CONFIRMATION/)
  assert.match(workspace, /reason\.trim\(\) === ""/)
  assert.match(workspace, /confirmation,/)
  assert.match(workspace, /reason,/)
})

test("provider identity is server authoritative without FORCE_LIVE or refresh work", async () => {
  const workspace = await read("settings-workspace.tsx")
  const api = await read("api.ts")

  assert.match(
    workspace,
    /client\.getSettings\(\s*websiteProjectKey,\s*signal\s*\)/
  )
  assert.match(workspace, /const load = useCallback/)
  assert.match(workspace, /item\.provider \?\? item\.capability/)
  assert.doesNotMatch(
    [api, workspace].join("\n"),
    /FORCE_LIVE|force_live|forceLive|Artifact|artifact/
  )
})

test("Retention exceptions are explained and remain read-only", async () => {
  const workspace = await read("settings-workspace.tsx")

  assert.match(workspace, /legal_hold/)
  assert.match(workspace, /audit_record/)
  assert.match(workspace, /lifecycle_record/)
  assert.match(workspace, /active_suppression/)
  assert.match(workspace, /只选择到期记录，不在读取路径执行删除/)
  assert.match(workspace, /法律保全中的记录不进入到期选择结果/)
  assert.match(workspace, /生命周期事实用于重建状态/)
  assert.doesNotMatch(
    workspace,
    /deleteRetention|updateRetention|removeRetention/
  )
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

test("Outreach governance does not replace platform settings navigation", async () => {
  const manifest = await read("../manifest.ts")
  const registration = await read("../registration.ts")
  const platformNavigation = await read("../../../app/platform-navigation.ts")

  assert.doesNotMatch(manifest, /\{ id: "settings"/)
  assert.match(registration, /id: "backlinks"/)
  assert.match(registration, /navigation: \[backlinksNavigation\]/)
  assert.doesNotMatch(platformNavigation, /外联规则与治理|SettingsWorkspace/)
})

test("legacy Settings manual preview is absent", async () => {
  await assert.rejects(() => read("manual-preview.tsx"), /ENOENT/)
  await assert.rejects(() => read("manual-preview.html"), /ENOENT/)
})
