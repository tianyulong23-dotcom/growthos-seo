import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const read = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")

test("BL-AI-140 uses the frozen BL-AI-135 and BL-AI-139 mail contracts", () => {
  const api = read("./api.ts")
  const types = read("./types.ts")

  assert.match(api, /from "@\/api\/client"/)
  assert.match(api, /\bapiRequest\b/)
  assert.match(api, /\/mail\/messages/)
  assert.match(api, /\/mail\/threads/)
  assert.match(api, /match-candidates/)
  assert.match(api, /expectedMatchStatus:\s*"CANDIDATES_READY"/)
  assert.match(api, /encodeURIComponent/)
  assert.match(types, /trust:\s*"SANITIZED"/)
  assert.match(types, /sanitized:\s*true/)
  assert.match(types, /confidenceScore/)
  assert.match(types, /reasonCodes/)
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
  assert.match(center, /目标 Opportunity/)
  assert.match(center, /线程版本/)
  assert.match(center, /confidenceScore/)
  assert.match(center, /reasonCodes/)
  assert.match(center, /isMailApiStatus\(error, 403\)/)
  assert.match(center, /isMailApiStatus\(error, 409\)/)
  assert.match(panel, /MailCenter/)
  assert.match(`${panel}\n${center}`, /BL-AI-130\.\.139/)
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
