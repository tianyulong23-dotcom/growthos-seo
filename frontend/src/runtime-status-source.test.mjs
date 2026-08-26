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
  assert.match(runtime, /core_api/)
  assert.match(runtime, /worker/)
  assert.match(runtime, /mode/)
  assert.match(runtime, /execution_mode/)
  assert.match(runtime, /"recovery"/)
  assert.match(runtime, /expected_build_id/)
  assert.match(runtime, /runtime_build_stale/)
  assert.match(runtime, /restart_product_runtime/)
  assert.match(runtime, /platform/)
  assert.match(runtime, /background_dispatch_enabled/)
  assert.match(runtime, /project_context_projection_enabled/)
  assert.match(runtime, /project_context_dispatcher_running/)
  assert.match(runtime, /recoverable_queued_project_analysis/)
  assert.match(runtime, /projection_delivery/)
  assert.match(runtime, /external_availability/)
  assert.match(runtime, /reason_code/)
  assert.match(runtime, /recovery_action/)
  assert.match(mailCenter, /business_consumers_running/)
  assert.match(mailCenter, /getRuntimeStatus/)
  assert.match(mailCenter, /5_000/)
})
