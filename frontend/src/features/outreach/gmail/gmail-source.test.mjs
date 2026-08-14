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

  assert.match(api, /requestBacklinks/)
  assert.match(hook, /createProjectQueryKey/)
  assert.match(hook, /backlinksProjectQueries\.fetch/)
  assert.match(hook, /getGmailConnectionStatus\(websiteProjectKey, signal\)/)
  assert.match(hook, /`\/projects\/\$\{websiteProjectKey\}\/backlinks\/email`/)
  assert.match(hook, /window\.location\.assign\(response\.authorizationUrl\)/)
  assert.match(hook, /gmailOAuth/)
  assert.match(hook, /invalid_or_expired/)
  assert.match(hook, /access_denied/)
  assert.match(hook, /10 分钟/)
  assert.match(hook, /window\.history\.replaceState/)
  assert.match(hook, /界面不会推断为已连接/)
  assert.match(panel, /授权已被撤销，需重新授权/)
  assert.match(panel, /发送受限/)
  assert.match(selector, /当前项目发件账号/)
  assert.match(selector, /选择已有账号不会再次打开/)
  assert.match(selector, /Send \{sendCapable \? "可用" : "暂停"\}/)
  assert.match(selector, /Sync \{syncCapable \? "可用" : "暂停"\}/)
  assert.match(panel, /确认断开/)
  assert.doesNotMatch(
    `${api}\n${hook}\n${panel}`,
    /localStorage|sessionStorage/
  )
})

test("BL-AI-122 creates only an approved Send Intent after an explicit review", () => {
  const draftApi = read("../drafts/api.ts")
  const draftPage = read("../drafts/draft-page.tsx")

  assert.match(draftApi, /backlinksListOpportunityContactsV1/)
  assert.match(draftApi, /backlinksPreflightSendIntentV1/)
  assert.match(draftApi, /backlinksCreateSendIntentV1/)
  assert.match(draftApi, /backlinksGetSendIntentV1/)
  assert.match(draftApi, /approvedDraftVersionId/)
  assert.match(draftApi, /gmailConnectionId/)
  assert.match(draftApi, /idempotency-key/)
  assert.doesNotMatch(draftApi, /apiRequest|send-intents/)
  assert.match(draftPage, /发送前最终确认/)
  assert.match(draftPage, /确定未发送/)
  assert.match(draftPage, /NOT_SENT/)
  assert.match(draftPage, /收件人/)
  assert.match(draftPage, /已批准版本/)
  assert.match(draftPage, /最终确认并发送/)
  assert.match(draftPage, /最终提交结果未知/)
  assert.match(draftPage, /Gmail Provider 已接受/)
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
  assert.match(draftPage, /禁止再次提交发送/)
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
