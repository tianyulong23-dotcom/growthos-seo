import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const projectsDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourceDirectory = path.resolve(projectsDirectory, "../..")

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        return sourceFiles(entryPath)
      }
      return /\.(ts|tsx)$/.test(entry.name) &&
        !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)
        ? [entryPath]
        : []
    })
  )
  return files.flat()
}

test("production routes do not fall back to the first project", async () => {
  const routeOwners = [
    "app/app-shell.tsx",
    "components/agent/agent-dock.tsx",
    "components/shared/page-header.tsx",
    "features/keywords/module.tsx",
    "features/outreach/module.tsx",
    "features/projects/project-context.tsx",
    "features/projects/project-route.ts",
    "pages/module-page.tsx",
  ]
  for (const relativePath of routeOwners) {
    const source = await readFile(
      path.join(sourceDirectory, relativePath),
      "utf8"
    )
    assert.doesNotMatch(source, /projects\[0\]/, relativePath)
  }
})

test("legacy project mocks stay outside the production import graph", async () => {
  const files = await sourceFiles(sourceDirectory)
  const productionSource = (
    await Promise.all(
      files
        .filter(
          (file) =>
            !file.endsWith(path.join("app", "project-context.ts")) &&
            !file.endsWith(path.join("projects", "project-workspace.tsx"))
        )
        .map((file) => readFile(file, "utf8"))
    )
  ).join("\n")

  assert.doesNotMatch(productionSource, /@\/app\/project-context/)
  assert.doesNotMatch(
    productionSource,
    /@\/features\/projects\/project-workspace/
  )
})

test("backlinks navigation has no project-management tab", async () => {
  const manifest = await readFile(
    path.join(sourceDirectory, "features/outreach/manifest.ts"),
    "utf8"
  )
  assert.doesNotMatch(manifest, /\bid:\s*["']projects["']/)
})
