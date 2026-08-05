const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:7200"

export class ApiError extends Error {
  public readonly status: number
  public readonly detail: unknown

  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.detail = detail
  }
}

export async function apiRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers)
  if (!headers.has("x-request-id")) {
    headers.set("x-request-id", crypto.randomUUID())
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { detail?: unknown }
      | null
    const detail = payload?.detail
    const message =
      typeof detail === "string"
        ? detail
        : detail &&
            typeof detail === "object" &&
            "message" in detail &&
            typeof detail.message === "string"
          ? detail.message
          : `API request failed: ${response.status}`
    throw new ApiError(response.status, message, detail)
  }

  return (await response.json()) as T
}
