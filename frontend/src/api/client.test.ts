import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError, apiRequest, resolveApiUrl } from "@/api/client"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("apiRequest", () => {
  it("accepts a successful 204 response without parsing JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    )

    await expect(
      apiRequest<void>("/api/v1/projects/project-1/audit-runs/run-1", {
        method: "DELETE",
      })
    ).resolves.toBeUndefined()
  })

  it("resolves platform-relative asset URLs against the API origin", () => {
    const configuredBase = (
      import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"
    ).replace(/\/+$/, "")
    expect(resolveApiUrl("/api/v1/projects/project-1/favicon?v=run-1")).toBe(
      `${configuredBase}/api/v1/projects/project-1/favicon?v=run-1`
    )
    expect(resolveApiUrl("https://example.com/favicon.ico")).toBe(
      "https://example.com/favicon.ico"
    )
  })

  it("keeps structured platform error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "stale_version",
              message: "stale_version",
              retryable: false,
              conflict_id: "item-a",
              current_version: 5,
            },
          },
          { status: 409 }
        )
      )
    )

    const error = await apiRequest("/structured-error").catch(
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 409,
      code: "stale_version",
      retryable: false,
      conflictId: "item-a",
      currentVersion: 5,
    })
  })
})
