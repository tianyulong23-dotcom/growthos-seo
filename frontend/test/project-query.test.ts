import assert from "node:assert/strict"
import test from "node:test"

import {
  createProjectQueryKey,
  ProjectQueryClient,
} from "../src/features/outreach/api/project-query.ts"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("project switching aborts the previous project's in-flight query", async () => {
  const client = new ProjectQueryClient()
  const oldResult = deferred<string>()
  let oldSignal: AbortSignal | undefined

  client.activateProject("project-a")
  const request = client.fetch(
    createProjectQueryKey("project-a", "recommendations"),
    (signal) => {
      oldSignal = signal
      return oldResult.promise
    }
  )
  client.activateProject("project-b")

  assert.equal(oldSignal?.aborted, true)
  oldResult.resolve("late-a")
  await assert.rejects(request, { name: "AbortError" })
})

test("a late aborted result is never cached", async () => {
  const client = new ProjectQueryClient()
  const first = deferred<string>()
  const key = createProjectQueryKey("project-a", "recommendations")
  let calls = 0

  client.activateProject("project-a")
  const oldRequest = client.fetch(key, () => {
    calls += 1
    return first.promise
  })
  client.activateProject("project-b")
  first.resolve("late")
  await assert.rejects(oldRequest, { name: "AbortError" })
  client.activateProject("project-a")

  assert.equal(await client.fetch(key, async () => "fresh"), "fresh")
  assert.equal(calls, 1)
})

test("cache entries never cross website project boundaries", async () => {
  const client = new ProjectQueryClient()
  let calls = 0
  const load = async () => `value-${++calls}`

  const projectA = await client.fetch(
    createProjectQueryKey("project-a", "links", "confirmed"),
    load
  )
  const projectB = await client.fetch(
    createProjectQueryKey("project-b", "links", "confirmed"),
    load
  )

  assert.equal(projectA, "value-1")
  assert.equal(projectB, "value-2")
})

test("project and resource prefixes invalidate only their scope", async () => {
  const client = new ProjectQueryClient()
  let calls = 0
  const load = async () => ++calls
  const recommendations = createProjectQueryKey("project-a", "recommendations")
  const links = createProjectQueryKey("project-a", "links")
  const otherProject = createProjectQueryKey("project-b", "links")

  await client.fetch(recommendations, load)
  await client.fetch(links, load)
  await client.fetch(otherProject, load)
  client.invalidate(["backlinks", "project-a", "recommendations"])

  assert.equal(await client.fetch(recommendations, load), 4)
  assert.equal(await client.fetch(links, load), 2)
  client.invalidateProject("project-a")
  assert.equal(await client.fetch(links, load), 5)
  assert.equal(await client.fetch(otherProject, load), 3)
})
