import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const read = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")

test("BL-AI-097 pins and restricts the Draft editor", () => {
  const packageJson = JSON.parse(read("../../../../package.json"))
  assert.equal(packageJson.dependencies["@tiptap/react"], "3.28.0")
  assert.equal(packageJson.dependencies["@tiptap/starter-kit"], "3.28.0")
  assert.equal(packageJson.dependencies["@tiptap/extension-link"], "3.28.0")
  assert.ok(
    Object.entries(packageJson.overrides)
      .filter(([name]) => name.startsWith("@tiptap/"))
      .every(([, version]) => version === "3.28.0")
  )

  const editor = read("./draft-editor.tsx")
  assert.match(editor, /currentEditor\.getJSON\(\)/)
  assert.doesNotMatch(editor, /dangerouslySetInnerHTML|getHTML\s*\(/)
  for (const disabled of [
    "blockquote",
    "code",
    "codeBlock",
    "heading",
    "horizontalRule",
    "strike",
    "underline",
  ]) {
    assert.match(editor, new RegExp(`${disabled}: false`))
  }
  assert.match(editor, /protocols: \["http", "https"\]/)
})

test("BL-AI-097 uses backend expectedVersion and keeps the editor free of send commands", () => {
  const api = read("./api.ts")
  const editor = read("./draft-editor.tsx")
  const page = read("./draft-page.tsx")
  const registration = read("../registration.ts")

  assert.match(api, /expectedVersion/)
  assert.match(api, /bodyDocument/)
  assert.doesNotMatch(editor, /\/send|sendDraft|autoSend/)
  assert.match(page, /snapshot\.draftVersion/)
  assert.match(page, /人工批准/)
  assert.match(page, /disabled=\{[\s\S]*basicDraftNeedsEdit/)
  assert.match(registration, /backlinks\/drafts\/:draftId/)
})

test("draft editing UI presents generation truth without exposing raw diagnostics first", () => {
  const editor = read("./draft-editor.tsx")
  const page = read("./draft-page.tsx")

  assert.match(editor, /role="toolbar"/)
  assert.match(editor, /aria-label="邮件格式"/)
  assert.match(page, /AI 未参与当前版本/)
  assert.match(page, /草稿语言需要校对/)
  assert.match(page, /发送邮件/)
  assert.doesNotMatch(page, /版本与生成详情|快照哈希|技术详情/)
  assert.doesNotMatch(page, />邮件版本</)
  assert.doesNotMatch(page, /失败分类：/)
})

test("draft editor keeps the email center return action visible while scrolling", () => {
  const page = read("./draft-page.tsx")

  assert.match(page, /sticky top-0 z-20/)
  assert.match(page, /返回邮件中心/)
  assert.match(page, /<ArrowLeft className="size-4" \/>/)
})
