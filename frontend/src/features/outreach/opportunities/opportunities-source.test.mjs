import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (file) => readFile(path.join(dirname, file), "utf8")

test("Opportunities use generated list, detail, and versioned commands", async () => {
  const api = await read("api.ts")
  const workspace = await read("opportunities-workspace.tsx")

  for (const operation of [
    "backlinksListOpportunitiesV1",
    "backlinksGetOpportunityV1",
    "backlinksTransitionOpportunityBusinessStageV1",
    "backlinksPatchOpportunityManagementV1",
    "backlinksPatchCooperationPathContentV1",
    "backlinksTransitionManualActionV1",
  ]) {
    assert.match(api, new RegExp(operation))
  }
  assert.match(api, /idempotencyKey/)
  assert.match(api, /search\?: string/)
  assert.match(workspace, /expectedVersion: detail\.version/)
  assert.match(workspace, /backlinksProjectQueries/)
  assert.match(workspace, /WAIT_FOR_DRAFT: "等待草稿生成"/)
  assert.doesNotMatch(
    workspace,
    /primaryNextActionLabels\[item\.primaryNextAction\.kind\]/
  )
  assert.match(workspace, /engagementPathState === "EMAIL_READY"/)
  assert.match(workspace, /drafts\/new\?opportunityId=\$\{detail\.id\}/)
  assert.match(workspace, /drafts\/\$\{detail\.draftId\}/)
  assert.match(
    workspace,
    /recommendations\?recommendationId=\$\{detail\.recommendationId\}/
  )
  assert.match(workspace, /detail\?\.selectionSnapshot \?\? null/)
  assert.match(workspace, /detail\.primaryNextAction\?\.kind/)
  assert.match(workspace, /return "CONTACT_PENDING"/)
  assert.match(workspace, /engagementPathState === "CONTACT_PENDING"/)
  assert.match(workspace, /function contactResolutionHref/)
  assert.match(workspace, /detail\.engagementChannel !== "EMAIL"/)
  assert.match(workspace, /完善联系人并创建草稿/)
  assert.match(workspace, /草稿仍需审阅、批准和最终发送确认/)
  assert.doesNotMatch(workspace, /请先从推荐记录补齐有效联系人/)
  assert.doesNotMatch(workspace, /createSendIntent/)
  assert.doesNotMatch(
    workspace,
    /detail\.engagementChannel === "EMAIL" && \(\s*<Link[\s\S]{0,500}撰写邮件/
  )
  assert.match(api, /\{ signal \}/)
})

test("Opportunities expose server states and conflict refresh without local mutation", async () => {
  const workspace = await read("opportunities-workspace.tsx")
  const parent = await read("../outreach-workspace.tsx")

  for (const state of [
    "loading",
    "empty",
    "data",
    "forbidden",
    "conflict",
    "not-found",
    "error",
  ]) {
    assert.match(workspace, new RegExp(`"${state}"`))
  }
  assert.match(workspace, /服务端版本已变化/)
  assert.match(workspace, /loadList\(true\)/)
  assert.match(workspace, /loadDetail\(true\)/)
  assert.doesNotMatch(workspace, /version\s*\+\s*1/)
  assert.doesNotMatch(workspace, /\.sort\(/)
  assert.doesNotMatch(`${workspace}\n${parent}`, /initialOpportunities/)
  assert.doesNotMatch(
    `${workspace}\n${parent}`,
    /createLocalDemoDraftFoundation/
  )
})

test("Opportunities keep ordering, archive, and restore server authoritative", async () => {
  const api = await read("api.ts")
  const workspace = await read("opportunities-workspace.tsx")

  assert.match(workspace, /useState<ManagementFilter>\("CURRENT"\)/)
  assert.match(
    workspace,
    /managementFilter === "CURRENT" \? undefined : managementFilter/
  )
  assert.match(workspace, /search: deferredSearch \|\| undefined/)
  assert.match(workspace, /setItems\(response\.items\)/)
  assert.match(workspace, /hasDownstreamFacts/)
  assert.match(workspace, /撤销加入/)
  assert.match(workspace, /归档/)
  assert.match(workspace, /恢复/)
  assert.match(workspace, /可选：补充说明/)
  assert.match(workspace, /idempotencyKey: crypto\.randomUUID\(\)/)
  assert.match(workspace, /result = await execute\(\)/)
  assert.match(workspace, /getOpportunity\(/)
  assert.match(workspace, /response\.item\.version <= action\.expectedVersion/)
  assert.match(api, /"idempotency-key": idempotencyKey/)
  assert.doesNotMatch(workspace, /DELETE/)
})

test("Cooperation paths require explicit manual submission confirmation", async () => {
  const workspace = await read("opportunities-workspace.tsx")

  const cooperationPanel = workspace.slice(
    workspace.indexOf('engagementPathState === "MANUAL_PATH_READY"'),
    workspace.indexOf(
      "<AlertDialog",
      workspace.indexOf('engagementPathState === "MANUAL_PATH_READY"')
    )
  )
  const openLink = cooperationPanel.slice(
    cooperationPanel.indexOf("<a"),
    cooperationPanel.indexOf("</a>") + 4
  )

  assert.match(openLink, /href=\{detail\.cooperationPath\.pathUrl\}/)
  assert.match(openLink, /target="_blank"/)
  assert.doesNotMatch(openLink, /onClick|applyManualTransition/)
  assert.match(cooperationPanel, /setSubmissionConfirmationOpen\(true\)/)
  assert.doesNotMatch(
    cooperationPanel,
    /applyManualTransition\("SUBMITTED", true\)/
  )
  assert.match(workspace, /applyManualTransition\("SUBMITTED", true\)/)
  assert.match(workspace, /submissionConfirmed: true/)
  assert.match(
    workspace,
    /打开或复制不会改变状态；只有明确确认后才会记录为已提交。/
  )
})
