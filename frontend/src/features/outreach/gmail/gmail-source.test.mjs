import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const read = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")

test("BL-AI-101..106 frontend uses token-free Gmail connection contracts", () => {
  const api = read("./api.ts")
  const types = read("./types.ts")
  const panel = read("./gmail-safety-panel.tsx")

  assert.match(api, /backlinksGetGmailConnectionStatusV1/)
  assert.match(api, /backlinksConnectGmailV1/)
  assert.match(api, /backlinksCompleteGmailConnectionV1/)
  assert.match(api, /backlinksDisconnectGmailV1/)
  assert.doesNotMatch(api, /apiRequest|gmail-connections/)
  assert.doesNotMatch(
    `${api}\n${types}`,
    /accessToken|refreshToken|authorizationCode/
  )
  assert.match(panel, /Token 不进入前端/)
  assert.match(panel, /不能手工跳级/)
})

test("BL-AI-121 Gmail connection UI distinguishes reauthorization and restricted states", () => {
  const api = read("./api.ts")
  const hook = read("./use-gmail-connection.ts")
  const panel = read("./gmail-safety-panel.tsx")
  const selector = read("./gmail-account-selector.tsx")
  const readiness = read("./gmail-readiness.tsx")

  assert.match(api, /requestBacklinks/)
  assert.match(hook, /createProjectQueryKey/)
  assert.match(hook, /backlinksProjectQueries\.fetch/)
  assert.match(hook, /getGmailConnectionStatus\(websiteProjectKey, signal\)/)
  assert.match(hook, /`\/projects\/\$\{websiteProjectKey\}\/backlinks\/email`/)
  assert.match(hook, /window\.location\.assign\(response\.authorizationUrl\)/)
  assert.match(hook, /OAUTH_ORIGIN_MISMATCH/)
  assert.match(hook, /canonicalFrontendOrigin/)
  assert.match(hook, /gmailOAuth/)
  assert.match(hook, /invalid_or_expired/)
  assert.match(hook, /access_denied/)
  assert.match(hook, /10 分钟/)
  assert.match(hook, /window\.history\.replaceState/)
  assert.match(hook, /界面不会推断为已连接/)
  assert.match(hook, /setReadiness\(response\.readiness\)/)
  assert.match(panel, /授权已被撤销，需重新授权/)
  assert.match(panel, /OAuth 连接有效；发送和同步门槛独立评估/)
  assert.match(panel, /GmailReadinessBlockers/)
  assert.match(selector, /发件账号/)
  assert.match(selector, /凭据暂时不可用/)
  assert.match(selector, /GOOGLE_AUTH_RATE_LIMITED/)
  assert.match(selector, /另有 \{controller\.accounts\.length - 1\} 个可用账号/)
  assert.doesNotMatch(
    selector,
    /Connection \{|Send \{|Sync \{|Connection：|Send：|Sync：/
  )
  assert.match(readiness, /gmailReadinessBlockerLabels/)
  assert.match(readiness, /gmailRecoveryActionLabels/)
  assert.match(readiness, /发送与同步尚未就绪/)
  assert.match(readiness, /SEND_CONTEXT_REQUIRED/)
  assert.match(readiness, /APPROVED_SEND_SNAPSHOT_MISSING/)
  assert.match(readiness, /查看 \{blockers\.length\} 项技术详情/)
  assert.match(readiness, /item\.retrySafe/)
  assert.match(readiness, /ownerLabels\[item\.owner\]/)
  assert.match(panel, /确认断开/)
  assert.doesNotMatch(
    `${api}\n${hook}\n${panel}`,
    /localStorage|sessionStorage/
  )
})

test("Phase 8 exposes a recovery instruction for every Gmail blocker action", () => {
  const readiness = read("./gmail-readiness.tsx")
  for (const action of [
    "CONNECT_GMAIL",
    "COMPLETE_GMAIL_OAUTH",
    "REAUTHORIZE_GMAIL",
    "SELECT_GMAIL_ACCOUNT",
    "REPAIR_PROJECT_BINDING",
    "GRANT_GMAIL_SEND_SCOPE",
    "GRANT_GMAIL_SYNC_SCOPE",
    "VERIFY_SEND_IDENTITY",
    "REPAIR_GMAIL_SECRET",
    "RESUME_GMAIL_SEND",
    "ENABLE_GMAIL_SEND_RUNTIME",
    "ENABLE_GMAIL_SYNC_RUNTIME",
    "START_GMAIL_WORKER",
    "OPEN_APPROVED_DRAFT",
    "REAPPROVE_CURRENT_DRAFT",
    "CLEAR_SEND_SUPPRESSION",
    "WAIT_FOR_SEND_QUOTA",
    "OPEN_GMAIL_SYNC_KILL_SWITCH",
    "REFRESH_GMAIL_READINESS",
    "REPAIR_GMAIL_SYNC_CURSOR",
  ]) {
    assert.match(readiness, new RegExp(`${action}:`))
  }
  assert.match(readiness, /GMAIL_TOKEN_REFRESH_FAILED/)
})

test("BL-AI-122 creates only an approved Send Intent after an explicit review", () => {
  const draftApi = read("../drafts/api.ts")
  const draftPage = read("../drafts/draft-page.tsx")

  assert.match(draftApi, /backlinksListOpportunityContactsV1/)
  assert.match(draftApi, /backlinksPreflightSendIntentV1/)
  assert.match(draftApi, /backlinksCreateSendIntentV1/)
  assert.match(draftApi, /backlinksGetSendIntentV1/)
  assert.match(
    draftApi,
    /BacklinksRequest<"backlinksCreateSendIntentV1">\["body"\]/
  )
  assert.match(draftApi, /idempotency-key/)
  assert.doesNotMatch(draftApi, /apiRequest|send-intents/)
  assert.match(draftPage, /approvedDraftVersionId/)
  assert.match(draftPage, /gmailConnectionId/)
  assert.match(draftPage, /readinessSnapshot/)
  assert.match(draftPage, /humanConfirmation/)
  assert.match(draftPage, /readinessSnapshotVersion/)
  assert.match(draftPage, /发送邮件/)
  assert.match(draftPage, /确定未发送/)
  assert.match(draftPage, /NOT_SENT/)
  assert.match(draftPage, /收件人/)
  assert.match(draftPage, /已批准版本/)
  assert.match(draftPage, /确认并发送/)
  assert.match(draftPage, /最终提交结果未知/)
  assert.match(draftPage, /邮件发送成功/)
  assert.match(draftPage, /这不代表收件人已读/)
  assert.doesNotMatch(draftPage, /Gmail 已接受邮件/)
  assert.match(draftPage, /DELIVERY_UNKNOWN/)
  assert.doesNotMatch(draftPage, /window\.location\.assign/)
})

test("BL-AI-107..120 frontend projects safety constraints without local send success", () => {
  const workspace = read("../outreach-workspace.tsx")
  const panel = read("./gmail-safety-panel.tsx")
  const draftPage = read("../drafts/draft-page.tsx")
  const reviewPath = fileURLToPath(
    new URL("./send-review-sheet.tsx", import.meta.url)
  )

  assert.doesNotMatch(workspace, /Mock 发送成功/)
  assert.equal(existsSync(reviewPath), false)
  assert.match(panel, /抑制 HMAC、24h 配额/)
  assert.match(panel, /NEW_CONNECTION/)
  assert.match(panel, /硬退信、投诉和退订立即抑制/)
  assert.match(panel, /软退信 30 天内累计 3 次后抑制/)
  assert.match(draftPage, /最终提交结果未知/)
  assert.match(draftPage, /当前不会重复提交/)
  assert.doesNotMatch(draftPage, /使用原请求键重试/)
  assert.doesNotMatch(draftPage, /Mock 发送成功/)
})

test("BL-AI-121..130 frontend preserves send controls and adds read-only mail sync projection", () => {
  const types = read("./types.ts")
  const workspace = read("../outreach-workspace.tsx")
  const mailSync = read("../mail/mail-sync-status-panel.tsx")

  assert.match(types, /mailSyncCapability: boolean/)
  assert.match(workspace, /MailSyncStatusPanel/)
  assert.match(mailSync, /连接 Gmail/)
  assert.match(mailSync, /MailCenter/)
  assert.doesNotMatch(mailSync, /accessToken|refreshToken|authorizationCode/)
  assert.doesNotMatch(
    mailSync,
    /BL-AI|Provider Adapter|gmail\.readonly|Token|审计事件|接口尚未开放|同步成功/
  )
})
