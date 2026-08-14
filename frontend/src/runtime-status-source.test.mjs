import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("the frontend exposes maintenance state and polls the public runtime status", async () => {
  const runtime = await readFile(
    new URL("./runtime-status.ts", import.meta.url),
    "utf8"
  )
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8")

  assert.match(runtime, /\/api\/v1\/runtime-status/)
  assert.match(app, /business_consumers_running/)
  assert.match(app, /后台任务处理已暂停/)
  assert.match(app, /草稿人工批准和发送前检查仍可用/)
  assert.match(app, /新建项目、后台任务和实际发送暂不可用/)
  assert.match(app, /5_000/)
})
