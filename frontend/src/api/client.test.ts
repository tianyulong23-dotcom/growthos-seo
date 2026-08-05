import { afterEach, describe, expect, it, vi } from "vitest"

import { apiRequest, resolveApiUrl } from "@/api/client"

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
})
