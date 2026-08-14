const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? ""
).replace(/\/+$/, "")

const validationLocationPrefixes = new Set([
  "body",
  "query",
  "path",
  "header",
  "cookie",
])

function extractErrorMessage(detail: unknown): string | null {
  if (typeof detail === "string") {
    return detail.trim() || null
  }
  if (!Array.isArray(detail)) {
    return null
  }

  const messages = detail.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return []
    }
    const record = item as { loc?: unknown; msg?: unknown }
    if (typeof record.msg !== "string" || !record.msg.trim()) {
      return []
    }
    const location = Array.isArray(record.loc)
      ? record.loc
          .filter(
            (part): part is string | number =>
              typeof part === "string" || typeof part === "number"
          )
          .map(String)
      : []
    if (location[0] && validationLocationPrefixes.has(location[0])) {
      location.shift()
    }
    return [
      location.length
        ? `${location.join(".")}: ${record.msg.trim()}`
        : record.msg.trim(),
    ]
  })

  return messages.length ? messages.join("; ") : null
}

export class ApiError extends Error {
  public readonly status: number
  public readonly code: string | null
  public readonly retryable: boolean
  public readonly conflictId: string | null
  public readonly currentVersion: number | null
  public readonly serverReviewVersion: number | null
  public readonly serverVersionNumber: number | null
  public readonly clientReviewVersion: number | null
  public readonly clientVersionNumber: number | null
  public readonly acceptedSequence: number | null
  public readonly recoverableAutosave: {
    id: string
    client_id: string
    sequence: number
    content_hash: string
    created_at: string
  } | null

  constructor(
    status: number,
    message: string,
    details?: {
      code?: string | null
      retryable?: boolean
      conflictId?: string | null
      currentVersion?: number | null
      serverReviewVersion?: number | null
      serverVersionNumber?: number | null
      clientReviewVersion?: number | null
      clientVersionNumber?: number | null
      acceptedSequence?: number | null
      recoverableAutosave?: ApiError["recoverableAutosave"]
    }
  ) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = details?.code ?? null
    this.retryable = details?.retryable ?? false
    this.conflictId = details?.conflictId ?? null
    this.currentVersion = details?.currentVersion ?? null
    this.serverReviewVersion = details?.serverReviewVersion ?? null
    this.serverVersionNumber = details?.serverVersionNumber ?? null
    this.clientReviewVersion = details?.clientReviewVersion ?? null
    this.clientVersionNumber = details?.clientVersionNumber ?? null
    this.acceptedSequence = details?.acceptedSequence ?? null
    this.recoverableAutosave = details?.recoverableAutosave ?? null
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
        detail?: unknown
        error?: {
          code?: string
          message?: string
          retryable?: boolean
          conflict_id?: string
          current_version?: number
          server_review_version?: number
          server_version_number?: number
          client_review_version?: number
          client_version_number?: number
          accepted_sequence?: number
          recoverable_autosave?: ApiError["recoverableAutosave"]
        }
      }
      const detailMessage = extractErrorMessage(body.detail)
      if (detailMessage) {
        message = detailMessage
      } else if (body.error?.message) {
        message = body.error.message
      }
      if (body.error) {
        details = {
          code: body.error.code,
          retryable: body.error.retryable,
          conflictId: body.error.conflict_id,
          currentVersion: body.error.current_version,
          serverReviewVersion: body.error.server_review_version,
          serverVersionNumber: body.error.server_version_number,
          clientReviewVersion: body.error.client_review_version,
          clientVersionNumber: body.error.client_version_number,
          acceptedSequence: body.error.accepted_sequence,
          recoverableAutosave: body.error.recoverable_autosave,
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
