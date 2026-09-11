import { describe, expect, it } from "vitest"

import { createProjectQueryKey, ProjectQueryClient } from "./project-query"

describe("ProjectQueryClient", () => {
  it("deduplicates an exact project query and reuses its cached value", async () => {
    const client = new ProjectQueryClient()
    const key = createProjectQueryKey(
      "project-a",
      "recommendation-feed",
      3,
      "items",
      "{}",
      null
    )
    let calls = 0
    const query = async () => {
      calls += 1
      return { project: "project-a", contextVersion: 3 }
    }

    const [first, second] = await Promise.all([
      client.fetch(key, query),
      client.fetch(key, query),
    ])
    const cached = await client.fetch(key, query)

    expect(first).toEqual(second)
    expect(cached).toEqual(first)
    expect(calls).toBe(1)
  })

  it("aborts an in-flight query when the active project changes", async () => {
    const client = new ProjectQueryClient()
    const firstProject = createProjectQueryKey(
      "project-a",
      "recommendation-feed",
      1
    )
    const secondProject = createProjectQueryKey(
      "project-b",
      "recommendation-feed",
      1
    )

    const superseded = client.fetch(
      firstProject,
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"))
          })
        })
    )
    await expect(
      client.fetch(secondProject, async () => "project-b")
    ).resolves.toBe("project-b")
    await expect(superseded).rejects.toMatchObject({ name: "AbortError" })
  })

  it("supersedes only the changed recommendation context", async () => {
    const client = new ProjectQueryClient()
    const prefix = ["backlinks", "project-a", "recommendation-feed"] as const
    const recommendationV1 = createProjectQueryKey(
      "project-a",
      "recommendation-feed",
      1,
      "items"
    )
    const recommendationV2 = createProjectQueryKey(
      "project-a",
      "recommendation-feed",
      2,
      "items"
    )
    const mail = createProjectQueryKey("project-a", "mail", "queue")
    const links = createProjectQueryKey("project-a", "links", "list")
    const reports = createProjectQueryKey("project-a", "reports", "summary")
    let recommendationCalls = 0
    let unrelatedCalls = 0

    client.activateScope(prefix, 1)
    await client.fetch(recommendationV1, async () => {
      recommendationCalls += 1
      return "context-1"
    })
    for (const key of [mail, links, reports]) {
      await client.fetch(key, async () => {
        unrelatedCalls += 1
        return key[2]
      })
    }

    client.activateScope(prefix, 2)
    await client.fetch(recommendationV2, async () => {
      recommendationCalls += 1
      return "context-2"
    })
    for (const key of [mail, links, reports]) {
      await client.fetch(key, async () => {
        unrelatedCalls += 1
        return "unexpected"
      })
    }

    expect(recommendationCalls).toBe(2)
    expect(unrelatedCalls).toBe(3)
  })

  it("rejects a delayed result from the superseded scope", async () => {
    const client = new ProjectQueryClient()
    const prefix = ["backlinks", "project-a", "recommendation-feed"] as const
    const firstContext = createProjectQueryKey(
      "project-a",
      "recommendation-feed",
      1,
      "items"
    )
    let resolveFirst: ((value: string) => void) | undefined

    client.activateScope(prefix, 1)
    const superseded = client.fetch(
      firstContext,
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve
        })
    )

    client.activateScope(prefix, 2)
    resolveFirst?.("stale-context")

    await expect(superseded).rejects.toMatchObject({ name: "AbortError" })
  })
})
