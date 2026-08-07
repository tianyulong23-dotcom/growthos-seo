const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"
).replace(/\/+$/, "")

export class ApiError extends Error {
  public readonly status: number
  public readonly code: string | null
  public readonly retryable: boolean
  public readonly conflictId: string | null
  public readonly currentVersion: number | null

  constructor(
    status: number,
    message: string,
    details?: {
      code?: string | null
      retryable?: boolean
      conflictId?: string | null
      currentVersion?: number | null
    }
  ) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = details?.code ?? null
    this.retryable = details?.retryable ?? false
    this.conflictId = details?.conflictId ?? null
    this.currentVersion = details?.currentVersion ?? null
  }
}

export async function apiRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(resolveApiUrl(path), init)

  if (!response.ok) {
    let message = `API request failed: ${response.status}`
    let details: ConstructorParameters<typeof ApiError>[2]
    try {
      const body = (await response.json()) as {
        detail?: string
        error?: {
          code?: string
          message?: string
          retryable?: boolean
          conflict_id?: string
          current_version?: number
        }
      }
      if (body.detail) {
        message = body.detail
      } else if (body.error?.message) {
        message = body.error.message
      }
      if (body.error) {
        details = {
          code: body.error.code,
          retryable: body.error.retryable,
          conflictId: body.error.conflict_id,
          currentVersion: body.error.current_version,
        }
      }
    } catch {
      // Keep the status-based fallback for non-JSON errors.
    }
    throw new ApiError(response.status, message, details)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

export function resolveApiUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || /^https?:\/\//i.test(trimmed)) {
    return trimmed
  }
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  return `${apiBaseUrl}${path}`
}
