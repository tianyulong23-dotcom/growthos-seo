import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (name) => readFile(new URL(name, import.meta.url), "utf8")

test("the ordinary outreach UI does not expose the global resource catalog", async () => {
  const [outreach, manifest, generated] = await Promise.all([
    read("../outreach-workspace.tsx"),
    read("../manifest.ts"),
    read("../../../api/generated/backlinks.ts"),
  ])

  assert.doesNotMatch(outreach, /ResourceLibraryWorkspace/)
  assert.doesNotMatch(outreach, /view === "resources"/)
  assert.doesNotMatch(manifest, /id: "resources"/)
  assert.match(generated, /backlinksListResourceLibraryV1/)
})
