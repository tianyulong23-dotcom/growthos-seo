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
  assert.match(panel, /MailCenter/)
  assert.match(panel, /重新授权/)
  assert.match(panel, /连接：/)
  assert.match(panel, /Send Ready：/)
  assert.match(panel, /Sync Ready：/)
  assert.match(panel, /缺少门槛：/)
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
