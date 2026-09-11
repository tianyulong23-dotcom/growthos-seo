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
    "backlinksListSendIntentsV1",
    "backlinksPreflightSendIntentV1",
  ]) {
    assert.match(api, new RegExp(operation))
  }
  assert.doesNotMatch(api, /backlinksGetAssessmentV1/)
  assert.doesNotMatch(api, /evidenceSnapshotId:\s*string/)
  assert.match(generation, /created\.evidenceSnapshotId/)
  assert.match(generation, /request:\s*\{/)
  assert.match(generation, /cooperationType/)
  assert.match(generation, /linkAttributePreference/)
  assert.match(generation, /promotionTargetUrl/)
  assert.match(generation, /getLatestDraftJob/)
  assert.match(generation, /pollIntervalMs = 1_500/)
  assert.match(generation, /searchParams\.get\("opportunityId"\)/)
  assert.match(generation, /searchParams\.get\("regenerate"\) === "1"/)
  assert.match(
    generation,
    /data-testid="draft-job-diagnostics"[\s\S]*?hidden[\s\S]*?aria-hidden="true"/
  )
  assert.match(
    generation,
    /`initial-outreach:\$\{opportunityId\}:\$\{selectedContact\.id\}`/
  )
  assert.match(generation, /requestKey\.current = null/)
  assert.match(generation, /\}, \[opportunityId, selectedContactId\]\)/)
  assert.doesNotMatch(generation, /setOpportunityId/)
  assert.match(page, /snapshot\.draftVersion/)
  assert.match(page, /getSendIntent/)
  assert.match(page, /preflightSendIntent/)
  assert.match(page, /deliveryState === "NOT_SENT"/)
  assert.match(page, /确定未发送/)
  assert.match(page, /terminalSendIntentStatuses/)
  assert.match(page, /nativeButton=\{false\}[\s\S]*?regenerate=1/)
  assert.doesNotMatch(page, /features\/outreach\/api\/client/)
})

test("LOCAL-PRODUCT-026 keeps Send disabled until typed server preflight passes", async () => {
  const api = await read("api.ts")
  const page = await read("draft-page.tsx")

  assert.match(api, /backlinksPreflightSendIntentV1/)
  for (const code of [
    "GMAIL_CONNECTION_NOT_SELECTED",
    "GMAIL_REAUTH_REQUIRED",
    "GMAIL_SEND_DISABLED",
    "GMAIL_SCOPE_INSUFFICIENT",
    "GMAIL_WORKER_UNAVAILABLE",
    "CONTACT_VERSION_STALE",
    "DRAFT_VERSION_STALE",
    "SEND_POLICY_REJECTED",
  ]) {
    assert.match(page, new RegExp(code))
  }
  assert.match(page, /sendPreflightReady/)
  assert.match(page, /sendPreconditionsReady[\s\S]*sendPreflightReady/)
  assert.match(page, /pendingSendConfirmationKey/)
  assert.match(page, /onCheckedChange=\{updateSendConfirmation\}/)
  assert.match(page, /isSendReadinessSnapshotUsable/)
  assert.match(page, /const recipientId = recipient\?\.id \?\? null/)
  assert.match(
    page,
    /const gmailConnectionId = gmailConnection\.connection\?\.connectionId \?\? null/
  )
  assert.doesNotMatch(
    page,
    /\[\s*approvedVersionMatchesCurrent,[\s\S]*gmailConnection\.connection,[\s\S]*recipient,[\s\S]*sendConfirmationKey/
  )
  assert.match(api, /query: \{ draftId, limit: 1 \}/)
  assert.match(page, /listDraftSendIntents/)
  assert.match(page, /sendHistoryStatus === "ready"/)
  assert.match(page, /setSendHistoryRefresh\(\(value\) => value \+ 1\)/)
  assert.match(
    page,
    /\[\s*draftId,[\s\S]*sendHistoryRefresh,[\s\S]*snapshotDraftVersion,[\s\S]*\]/
  )
  assert.match(page, /sendIntentView\?\.diagnostics\.resubmittable/)
  assert.match(page, /GMAIL_SEND_TOKEN_REFRESH_FAILED/)
  assert.match(page, /GMAIL_SEND_PROVIDER_NETWORK/)
  assert.match(page, /persistedSendStatus === "FAILED_RETRYABLE"/)
  assert.doesNotMatch(
    page,
    /case "GMAIL_SEND_PRE_REQUEST_FAILED":[\s\S]{0,180}自动重试/
  )
  assert.match(page, /prepareSendResubmission/)
  assert.match(page, /已加入发送队列/)
  assert.match(page, /邮件发送成功/)
  assert.doesNotMatch(page, />邮件版本</)
  assert.match(
    page,
    /const gmailReady =[\s\S]*gmailConnection\.readiness\?\.connection\.ready === true/
  )
  assert.match(page, /\{gmailReady \? "Gmail 已连接" : "Gmail 尚未就绪"\}/)
  assert.doesNotMatch(
    page,
    /sendPreflight\?\.gmail\.connectionStatus === "CONNECTED"\s*\|\|/
  )
  assert.match(
    page,
    /persistedSendStatus === "PROVIDER_ACCEPTED"[\s\S]*\? "sent"/
  )
  assert.match(page, /effectiveDraftStatus === "sent"[\s\S]*邮件已发送/)
  assert.match(page, /notice && !sendRecordPresent/)
  assert.doesNotMatch(page, /Gmail 已接受邮件/)
  assert.match(page, /发送结果需要核对/)
  assert.match(page, /重新准备发送/)
  assert.match(page, /本次预检不会创建 Send Intent/)
  assert.match(page, /currentVersion\?\.source === "TEMPLATE_FALLBACK"/)
  assert.match(page, /sendPreconditionsReady[\s\S]*!basicDraftNeedsEdit/)
  assert.match(page, /AI 未参与当前版本[\s\S]*系统改用基础模板/)
  assert.match(page, /新版本会标记为人工编辑后再进入审批/)
  assert.equal([...page.matchAll(/createSendIntent\(/g)].length, 1)
})

test("LOCAL-PRODUCT-018 polls durable states and distinguishes deterministic fallback", async () => {
  const generation = await read("draft-generation.tsx")
  const polling = await read("draft-job-polling.ts")
  const page = await read("draft-page.tsx")
  const parent = await read("../outreach-workspace.tsx")

  for (const state of [
    "QUEUED",
    "RUNNING",
    "RETRY_SCHEDULED",
    "SUCCEEDED",
    "FAILED",
    "REFUSED",
  ]) {
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
  assert.doesNotMatch(`${generation}\n${page}`, /mock-data/i)
  assert.match(generation, /TEMPLATE_FALLBACK/)
  assert.match(generation, /BASIC_DRAFT_READY/)
  assert.match(generation, /非 AI 基础草稿/)
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

test("Draft generation keeps the opportunity return action prominent", async () => {
  const generation = await read("draft-generation.tsx")

  assert.match(generation, /size="sm"[\s\S]{0,500}返回外链机会/)
  assert.match(generation, /sticky top-0 z-20/)
  assert.doesNotMatch(
    generation,
    /text-xs text-muted-foreground hover:text-foreground/
  )
})
