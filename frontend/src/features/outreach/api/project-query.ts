export type ProjectQueryPart = string | number | boolean | null
export type ProjectQueryKey = readonly [
  "backlinks",
  websiteProjectKey: string,
  resource: string,
  ...scope: ProjectQueryPart[],
]

type QueryEntry = {
  key: ProjectQueryKey
  controller: AbortController | null
  promise: Promise<unknown> | null
  value: unknown
  hasValue: boolean
}

const serializeKey = (key: ProjectQueryKey) => JSON.stringify(key)
const isPrefix = (key: ProjectQueryKey, prefix: readonly unknown[]) =>
  prefix.every((part, index) => key[index] === part)

export function createProjectQueryKey(
  websiteProjectKey: string,
  resource: string,
  ...scope: ProjectQueryPart[]
): ProjectQueryKey {
  if (!websiteProjectKey.trim()) {
    throw new Error("websiteProjectKey is required")
  }
  if (!resource.trim()) {
    throw new Error("resource is required")
  }
  return ["backlinks", websiteProjectKey, resource, ...scope]
}

export class ProjectQueryClient {
  private readonly entries = new Map<string, QueryEntry>()
  private readonly activeScopes = new Map<string, ProjectQueryPart>()
  private activeProjectKey: string | null = null

  activateProject(websiteProjectKey: string) {
    if (this.activeProjectKey === websiteProjectKey) return
    this.activeProjectKey = websiteProjectKey
    for (const entry of this.entries.values()) {
      if (entry.key[1] !== websiteProjectKey) {
        entry.controller?.abort()
        entry.controller = null
        entry.promise = null
      }
    }
  }

  activateScope(
    prefix: readonly ProjectQueryPart[],
    activeScope: ProjectQueryPart
  ) {
    const serializedPrefix = JSON.stringify(prefix)
    if (this.activeScopes.get(serializedPrefix) === activeScope) return

    this.activeScopes.set(serializedPrefix, activeScope)
    for (const [serialized, entry] of this.entries) {
      if (
        isPrefix(entry.key, prefix) &&
        entry.key[prefix.length] !== activeScope
      ) {
        entry.controller?.abort()
        this.entries.delete(serialized)
      }
    }
  }

  fetch<T>(
    key: ProjectQueryKey,
    query: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    this.activateProject(key[1])
    const serialized = serializeKey(key)
    const existing = this.entries.get(serialized)
    if (existing?.hasValue) return Promise.resolve(existing.value as T)
    if (existing?.promise) return existing.promise as Promise<T>

    const controller = new AbortController()
    const entry: QueryEntry = {
      key,
      controller,
      promise: null,
      value: undefined,
      hasValue: false,
    }
    const promise = query(controller.signal)
      .then((value) => {
        if (
          controller.signal.aborted ||
          this.activeProjectKey !== key[1] ||
          this.entries.get(serialized) !== entry
        ) {
          throw new DOMException(
            "Project query superseded by project switch",
            "AbortError"
          )
        }
        entry.value = value
        entry.hasValue = true
        return value
      })
      .catch((error: unknown) => {
        if (this.entries.get(serialized) === entry) {
          this.entries.delete(serialized)
        }
        throw error
      })
    entry.promise = promise
    this.entries.set(serialized, entry)
    return promise.finally(() => {
      if (this.entries.get(serialized) === entry) {
        entry.controller = null
        entry.promise = null
      }
    })
  }

  invalidate(prefix: readonly unknown[]) {
    for (const [serialized, entry] of this.entries) {
      if (isPrefix(entry.key, prefix)) {
        entry.controller?.abort()
        this.entries.delete(serialized)
      }
    }
  }

  invalidateProject(websiteProjectKey: string) {
    this.invalidate(["backlinks", websiteProjectKey])
  }
}

export const backlinksProjectQueries = new ProjectQueryClient()
