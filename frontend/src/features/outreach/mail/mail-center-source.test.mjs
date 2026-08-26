import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const read = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")

test("BL-AI-186 uses generated frozen mail and match operations", () => {
  const api = read("./api.ts")
  const types = read("./types.ts")
  const generated = read("../../../api/generated/backlinks.ts")

  assert.match(api, /requestBacklinks/)
  for (const operation of [
    "backlinksListReplyMailMessagesV1",
    "backlinksGetReplyMailMessageV1",
    "backlinksGetReplyMailThreadV1",
    "backlinksListReplyMatchCandidatesV1",
    "backlinksConfirmReplyMatchCandidateV1",
    "backlinksUnbindReplyMatchV1",
    "backlinksGetGmailPollingSyncStatusV1",
    "backlinksListNegotiationFactsV1",
    "backlinksReviewNegotiationFactV1",
    "backlinksListSendIntentsV1",
    "backlinksGetSendIntentV1",
  ]) {
    assert.match(api, new RegExp(operation))
  }
  assert.match(api, /expectedMatchStatus:\s*"CANDIDATES_READY"/)
  assert.match(api, /expectedMatchStatus:\s*"MATCH_CONFIRMED"/)
  assert.match(api, /\{ signal \}/)
  assert.match(types, /BacklinksResponse/)
  assert.match(types, /SanitizedMailHtml/)
  assert.match(generated, /trust:\s*"SANITIZED"/)
  assert.match(generated, /sanitized:\s*true/)
  assert.doesNotMatch(api, /\bapiRequest\b|\/api\/v1\/projects/)
  assert.doesNotMatch(
    `${api}\n${types}`,
    /accessToken|refreshToken|authorizationCode|rawObjectKey/
  )
})

test("P4 Mail Center reads the project Send Intent queue without send side effects", () => {
  const api = read("./api.ts")
  const center = read("./mail-center.tsx")
  const queue = read("./send-intent-queue.tsx")

  assert.match(api, /backlinksListSendIntentsV1/)
  assert.match(api, /backlinksGetSendIntentV1/)
  assert.match(api, /queueKind:\s*input\.queueKind \?\? undefined/)
  assert.match(api, /\{ signal \}/)
  assert.match(center, /SendIntentQueue/)
  assert.match(queue, /"send-intents"/)
  assert.match(queue, /"send-intent-detail"/)
  assert.match(queue, /activeProjectRef/)
  assert.match(queue, /backlinksProjectQueries\.invalidate\(listKey\)/)
  assert.match(queue, /RECONCILIATION_REQUIRED/)
  assert.match(queue, /RECONCILE_BEFORE_RETRY/)
  assert.match(queue, /先核对 Gmail 结果，禁止自动重发/)
  assert.match(queue, /PROVIDER_ACCEPTED:\s*"已发送"/)
  assert.doesNotMatch(queue, /Gmail 已接受/)
  assert.match(queue, /deliveryEnvelope/)
  assert.match(queue, /diagnostics\.primaryNextAction/)
  assert.match(queue, /getSendIntent/)
  assert.match(queue, /listSendIntents/)
  assert.doesNotMatch(
    `${api}\n${queue}`,
    /createSendIntent|preflightSendIntent|sendGmail|retrySendIntent/
  )
})

test("BL-AI-140 replaces the protected workspace mail mock", () => {
  const workspace = read("../outreach-workspace.tsx")

  assert.match(workspace, /MailSyncStatusPanel/)
  assert.doesNotMatch(workspace, /\bemailTab\b/)
  assert.doesNotMatch(workspace, /SendReviewSheet/)
  assert.doesNotMatch(workspace, /AI Draft 本地演示/)
})

test("BL-AI-140 exposes resilient list, thread, pagination, and manual match states", () => {
  const center = read("./mail-center.tsx")
  const panel = read("./mail-sync-status-panel.tsx")
  const projectKey = read("./project-key.ts")

  for (const state of [
    "loading",
    "empty",
    "error",
    "forbidden",
    "conflict",
    "stale",
  ]) {
    assert.match(center, new RegExp(state))
  }

  assert.match(center, /hasMore/)
  assert.match(center, /nextCursor/)
  assert.match(center, /人工确认/)
  assert.match(center, /确认关联/)
  assert.match(center, /confidenceScore/)
  assert.match(center, /reasonCodes/)
  assert.match(center, /PROVIDER_THREAD_EXACT/)
  assert.match(center, /QUOTED_BODY_FINGERPRINT/)
  assert.match(center, /Opportunity：/)
  assert.match(center, /游标/)
  assert.match(center, /pollingIntervalSeconds/)
  assert.match(center, /lastSuccessfulSyncAt/)
  assert.match(center, /lastError/)
  assert.match(center, /nextRetryAt/)
  assert.match(center, /data-testid="mail-sync-diagnostics"/)
  assert.doesNotMatch(
    center,
    /data-testid="mail-sync-diagnostics"[\s\S]*?hidden[\s\S]*?aria-hidden="true"/
  )
  assert.match(center, /最近成功/)
  assert.match(center, /最近错误/)
  assert.match(center, /下次重试/)
  assert.match(center, /维护模式：后台 Worker 未运行/)
  assert.match(center, /已保存邮件仍可读取；立即同步暂不可用/)
  assert.match(center, /businessConsumersRunning !== true/)
  assert.match(center, /getRuntimeStatus/)
  assert.match(center, /立即同步并刷新邮件/)
  assert.match(center, /解除错误关联/)
  assert.match(center, /isMailApiStatus\(error, 403\)/)
  assert.match(center, /isMailApiStatus\(error, 409\)/)
  assert.match(center, /backlinksProjectQueries/)
  assert.match(center, /createProjectQueryKey/)
  assert.match(center, /"mail-messages"/)
  assert.match(center, /"mail-thread"/)
  assert.match(center, /"reply-match-candidates"/)
  assert.match(center, /attempt < 15/)
  assert.match(center, /existingIds/)
  assert.match(center, /Gmail 同步已暂停，当前显示已保存邮件/)
  assert.match(center, /applyFirstPage\(await fetchFirstPage\(\)\)/)
  assert.doesNotMatch(center, /setTimeout\(resolve,\s*5_000\)/)
  assert.match(center, /邮件往来/)
  assert.match(center, /同步详情/)
  assert.match(center, /<details/)
  assert.ok(
    center.indexOf("邮件往来") <
      center.indexOf("<SendIntentQueue websiteProjectKey={websiteProjectKey}")
  )
  assert.match(panel, /MailCenter/)
  assert.match(panel, /重新授权/)
  assert.match(panel, /Gmail 已连接/)
  assert.doesNotMatch(panel, /Connection：|Send Ready：|Sync Ready：/)
  assert.match(panel, /GmailReadinessBlockers/)
  assert.match(panel, /WAITING_FOR_ACCEPTED_SEND/)
  assert.match(panel, /WAITING_FOR_SEND_CONTEXT/)
  assert.match(panel, /已保存邮件仍可读取/)
  assert.doesNotMatch(`${center}\n${panel}`, /mock|fallback|demo/i)
  assert.doesNotMatch(
    `${panel}\n${center}`,
    /BL-AI|线程版本|目标 Opportunity|Provider Adapter|gmail\.readonly/
  )
  assert.ok(projectKey.includes("pathname.match(/\\/projects\\/([^/]+)/)"))
})

test("BL-AI-140 renders only plain text or server-marked sanitized HTML", () => {
  const center = read("./mail-center.tsx")

  assert.match(center, /body\.plainText/)
  assert.match(center, /trust === "SANITIZED"/)
  assert.match(center, /sanitized === true/)
  assert.match(center, /srcDoc=/)
  assert.match(center, /sandbox=""/)
  assert.match(center, /referrerPolicy="no-referrer"/)
  assert.doesNotMatch(center, /dangerouslySetInnerHTML/)
  assert.doesNotMatch(
    center,
    /autoConfirm|confirmAutomatically|发送成功|同步成功/
  )
})

test("Mail Center always exposes Gmail reconnection after token refresh failure", () => {
  const panel = read("./mail-sync-status-panel.tsx")

  assert.match(panel, /"GMAIL_TOKEN_REFRESH_FAILED"/)
  assert.match(panel, /重新连接 Gmail/)
  assert.match(panel, /onClick=\{\(\) => void controller\.connect\(\)\}/)
})

test("Mail Center does not report sync available while Gmail readiness is blocked", () => {
  const center = read("./mail-center.tsx")
  const panel = read("./mail-sync-status-panel.tsx")

  assert.match(
    panel,
    /gmailSyncReady=\{controller\.readiness\?\.sync\.ready === true\}/
  )
  assert.match(center, /gmailSyncReady: boolean/)
  assert.match(
    center,
    /businessConsumersRunning === true && gmailSyncReady/
  )
  assert.match(center, /Gmail 凭据需要重新连接；已保存邮件仍可读取/)
  assert.match(center, /!gmailSyncReady/)
})

test("Phase 10 keeps negotiation facts versioned, review-gated, and project attributed", () => {
  const api = read("./api.ts")
  const center = read("./mail-center.tsx")
  const panel = read("./negotiation-facts-panel.tsx")

  assert.match(api, /backlinksListNegotiationFactsV1/)
  assert.match(api, /backlinksReviewNegotiationFactV1/)
  assert.match(api, /"idempotency-key": idempotencyKey/)
  assert.match(panel, /expectedFactVersion:\s*selectedFact\.factVersion/)
  assert.match(panel, /reviewRequestKey\.current \?\? crypto\.randomUUID\(\)/)
  assert.match(panel, /reviewRequestKey\.current = idempotencyKey/)
  assert.match(panel, /decision === "CORRECT"/)
  assert.match(panel, /JSON\.parse\(correctionNormalizedValue\)/)
  assert.match(panel, /beginReview\(fact, "CONFIRM"\)/)
  assert.match(panel, /beginReview\(fact, "REJECT"\)/)
  assert.match(panel, /beginReview\(fact, "CORRECT"\)/)
  assert.match(panel, /backlinksProjectQueries/)
  assert.match(panel, /response\.opportunityId !== opportunityId/)
  assert.match(panel, /isMailApiStatus\(error, 409\)/)
  assert.match(panel, /追加版本，不覆盖原始提取记录/)
  assert.match(center, /opportunityId/)
  assert.match(center, /replyId/)
  assert.match(center, /returnTo/)
  assert.match(center, /businessContextPath/)
  assert.doesNotMatch(
    `${api}\n${center}\n${panel}`,
    /accessToken|refreshToken|authorizationCode|rawObjectKey/
  )
})
