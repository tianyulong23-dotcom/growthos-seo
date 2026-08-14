import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("mail maintenance state uses the public runtime status endpoint", async () => {
  const runtime = await readFile(
    new URL("./runtime-status.ts", import.meta.url),
    "utf8"
  )
  const mailCenter = await readFile(
    new URL("./features/outreach/mail/mail-center.tsx", import.meta.url),
    "utf8"
  )

  assert.match(runtime, /\/api\/v1\/runtime-status/)
  assert.match(mailCenter, /business_consumers_running/)
  assert.match(mailCenter, /getRuntimeStatus/)
  assert.match(mailCenter, /5_000/)
})
