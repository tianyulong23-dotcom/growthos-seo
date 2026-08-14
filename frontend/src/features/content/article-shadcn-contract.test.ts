/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const contentDirectory = join(process.cwd(), "src/features/content")
const nativeInteractiveElement = /<(button|input|textarea|select|dialog)\b/g

describe("article editor shadcn/ui contract", () => {
  it("uses shadcn/ui for interactive elements outside TipTap", () => {
    const violations = readdirSync(contentDirectory)
      .filter(
        (fileName) =>
          fileName.startsWith("article-") &&
          fileName.endsWith(".tsx") &&
          !fileName.endsWith(".test.tsx")
      )
      .flatMap((fileName) => {
        const source = readFileSync(`${contentDirectory}/${fileName}`, "utf8")
        return Array.from(source.matchAll(nativeInteractiveElement), (match) =>
          `${fileName}: <${match[1]}>`
        )
      })

    expect(violations).toEqual([])
  })
})
