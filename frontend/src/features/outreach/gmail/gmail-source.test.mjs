import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const read = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")

test("BL-AI-101..106 frontend uses token-free Gmail connection contracts", () => {
  const api = read("./api.ts")
  const types = read("./types.ts")
  const panel = read("./gmail-safety-panel.tsx")

  assert.match(api, /gmail-connections.*status/s)
  assert.match(api, /gmail-connections.*connect/s)
  assert.match(api, /disconnect/s)
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

  assert.match(api, /gmail-connections.*status/s)
  assert.match(api, /gmail-connections.*connect/s)
  assert.match(api, /disconnect/s)
  assert.match(hook, /window\.location\.assign\(response\.authorizationUrl\)/)
  assert.match(hook, /界面不会推断为已连接/)
  assert.match(panel, /授权已被撤销，需重新授权/)
  assert.match(panel, /发送受限/)
  assert.match(panel, /确认断开/)
  assert.doesNotMatch(
    `${api}\n${hook}\n${panel}`,
    /localStorage|sessionStorage/
  )
})

test("BL-AI-122 creates only an approved Send Intent after an explicit review", () => {
  const draftApi = read("../drafts/api.ts")
  const draftPage = read("../drafts/draft-page.tsx")

  assert.match(draftApi, /send-intents/)
  assert.match(draftApi, /approvedDraftVersionId/)
  assert.match(draftApi, /gmailConnectionId/)
  assert.match(draftApi, /idempotency-key/)
  assert.match(draftPage, /二次确认/)
  assert.match(draftPage, /发送身份/)
  assert.match(draftPage, /收件人/)
  assert.match(draftPage, /已批准版本/)
  assert.match(draftPage, /创建 Send Intent/)
  assert.match(draftPage, /创建结果未知/)
  assert.match(draftPage, /不是发送成功/)
  assert.doesNotMatch(draftPage, /window\.location\.assign/)
})

test("BL-AI-107..120 frontend projects safety constraints without local send success", () => {
  const workspace = read("../outreach-workspace.tsx")
  const panel = read("./gmail-safety-panel.tsx")
  const review = read("./send-review-sheet.tsx")

  assert.doesNotMatch(workspace, /Mock 发送成功/)
  assert.match(review, /Suppression 与配额/)
  assert.match(review, /NEW_CONNECTION/)
  assert.match(review, /BL-AI-122/)
  assert.match(review, /HARD_BOUNCE/)
  assert.match(review, /SOFT_BOUNCE_THRESHOLD/)
  assert.match(review, /DELIVERY_UNKNOWN/)
  assert.match(review, /普通用户不能解除/)
  assert.match(panel, /软退信 30 天内累计 3 次后抑制/)
  assert.match(review, /本地演示不可发送/)
  assert.match(review, /<Button disabled>/)
  assert.doesNotMatch(review, /发送成功|已发送/)
})

test("BL-AI-121..130 frontend preserves send controls and adds read-only mail sync projection", () => {
  const types = read("./types.ts")
  const workspace = read("../outreach-workspace.tsx")
  const mailSync = read("../mail/mail-sync-status-panel.tsx")

  assert.match(types, /mailSyncCapability: boolean/)
  assert.match(workspace, /MailSyncStatusPanel/)
  assert.match(mailSync, /gmail\.readonly/)
  assert.match(mailSync, /Provider Adapter 默认关闭/)
  assert.match(mailSync, /初始同步固定回看 7 天/)
  assert.match(mailSync, /最多 10 页 \/ 1000\s+条/)
  assert.match(mailSync, /审计事件/)
  assert.match(mailSync, /运行状态读接口尚未开放/)
  assert.doesNotMatch(mailSync, /accessToken|refreshToken|authorizationCode/)
  assert.doesNotMatch(mailSync, /同步成功/)
})
