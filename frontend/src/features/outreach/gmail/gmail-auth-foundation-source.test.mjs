import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const read = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")

test("BL-AI-099/100 exposes only the Gmail authorization foundation", () => {
  const model = read("./gmail-auth-foundation-model.ts")
  const panel = read("./gmail-auth-foundation.tsx")

  assert.match(model, /connectionState: "not_connected"/)
  assert.match(model, /oauthStateStorage: "sha256_hash"/)
  assert.match(model, /pkceMethod: "S256"/)
  assert.match(model, /pkceStorage: "secret_reference"/)
  assert.match(model, /expiresInSeconds: 600/)
  assert.match(model, /connectAvailable: false/)
  assert.match(model, /sendAvailable: false/)
  assert.doesNotMatch(model, /accessToken|refreshToken|pkceVerifier/)

  assert.match(panel, /Gmail 授权基础/)
  assert.match(panel, /未连接/)
  assert.match(panel, /服务端一次性/)
  assert.match(panel, /Secret Reference/)
  assert.match(panel, /真实 Google 授权未开放/)
  assert.doesNotMatch(panel, /连接 Gmail|断开连接|确认发送/)
})
