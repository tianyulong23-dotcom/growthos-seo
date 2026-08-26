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
    expect(resolveApiUrl("/api/v1/projects/project-1/favicon?v=run-1")).toBe(
      "/api/v1/projects/project-1/favicon?v=run-1"
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

  it("keeps exact readiness changes from RFC Problem Details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            type: "about:blank",
            title: "Send readiness changed",
            status: 409,
            code: "SEND_READINESS_STALE",
            message:
              "The confirmed send readiness conditions changed.",
            retryable: true,
            changedConditions: [
              {
                code: "QUOTA",
                reason: "CHANGED",
                expectedRevision: "0/5",
                currentRevision: "5/5",
                retryable: true,
                recoveryAction: "WAIT_AND_RUN_PREFLIGHT",
              },
            ],
          },
          { status: 409 }
        )
      )
    )

    const error = await apiRequest("/send-intent").catch(
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 409,
      code: "SEND_READINESS_STALE",
      retryable: true,
      changedConditions: [
        {
          code: "QUOTA",
          reason: "CHANGED",
          expectedRevision: "0/5",
          currentRevision: "5/5",
          retryable: true,
          recoveryAction: "WAIT_AND_RUN_PREFLIGHT",
        },
      ],
    })
  })

  it("formats FastAPI validation details with their field paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            detail: [
              {
                type: "value_error",
                loc: ["body", "metadata", "canonical_url"],
                msg: "Value error, canonical_url must be an absolute HTTP(S) URL",
                input: "javascript:alert(1)",
              },
            ],
          },
          { status: 422 }
        )
      )
    )

    const error = await apiRequest("/validation-error").catch(
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 422,
      message:
        "metadata.canonical_url: Value error, canonical_url must be an absolute HTTP(S) URL",
    })
  })
})
