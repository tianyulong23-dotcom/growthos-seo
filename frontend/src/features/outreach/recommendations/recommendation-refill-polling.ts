export type RecommendationRefillPollSnapshot = Readonly<{
  operationId: string | null
  stage:
    | "blueprint"
    | "discovery"
    | "match"
    | "contact"
    | "publish"
    | "complete"
    | "pause"
  terminal: boolean
  terminalState:
    | "TARGET_REACHED"
    | "PAUSED_BUDGET"
    | "PAUSED_PROVIDER"
    | "PROJECT_CONTEXT_REQUIRED"
    | "SUPPLY_FLOOR_REACHED"
    | null
  publishedCount: number
  refillInFlight: boolean
  refillState:
    | "idle"
    | "running"
    | "waiting_contact"
    | "completed"
    | "paused"
    | "exhausted"
  serverUpdatedAt: string | null
  refillJob: Readonly<{
    id: string
    status:
      | "queued"
      | "running"
      | "waiting_provider"
      | "partial_success"
      | "success"
      | "failed"
      | "cancelled"
    progress: number
    updatedAt: string
  }> | null
  contactBatch: Readonly<{
    id: string
    status: "running" | "completed" | "stale_context"
    totalJobCount: number
    terminalJobCount: number
    nextRetryAt: string | null
    startedAt: string
  }> | null
}>

type PollOptions<T extends RecommendationRefillPollSnapshot> = Readonly<{
  signal: AbortSignal
  getInventory(signal: AbortSignal): Promise<T>
  onInventory(inventory: T): void
  shouldContinue(inventory: T): boolean
  onTerminal(inventory: T): void | Promise<void>
  onError?(error: unknown): void
  onBackgroundContinuation?(reason: "timeout" | "read_errors"): void
  sleep?: (intervalMs: number, signal: AbortSignal) => Promise<boolean>
  now?: () => number
  maximumActivePollingMs?: number
  maximumConsecutiveErrors?: number
}>

export const recommendationRefillPollDelaysMs = [
  1_500, 2_500, 4_000, 6_500, 10_000, 15_000,
] as const

const activeJobStatuses = new Set(["queued", "running", "waiting_provider"])
const contactRecoveryGraceMs = 10 * 60_000
const operationRecoveryGraceMs = 10 * 60_000

export type RecommendationContactBatchActivity =
  | "none"
  | "processing"
  | "waiting_retry"
  | "recovery_required"
  | "completed"
  | "stale_context"

const parseTime = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function recommendationContactBatchActivity(
  inventory: RecommendationRefillPollSnapshot,
  now = Date.now()
): RecommendationContactBatchActivity {
  const batch = inventory.contactBatch
  if (batch === null) return "none"
  if (
    batch.status === "completed" ||
    (batch.totalJobCount > 0 && batch.terminalJobCount >= batch.totalJobCount)
  ) {
    return "completed"
  }
  if (batch.status === "stale_context") return "stale_context"

  const nextRetryAt = parseTime(batch.nextRetryAt)
  if (nextRetryAt !== null && nextRetryAt > now) return "waiting_retry"

  const lastProgressAt =
    parseTime(inventory.serverUpdatedAt) ??
    parseTime(inventory.refillJob?.updatedAt) ??
    parseTime(batch.startedAt)
  if (
    lastProgressAt !== null &&
    now - lastProgressAt >= contactRecoveryGraceMs
  ) {
    return "recovery_required"
  }
  return "processing"
}

export function isRecommendationRefillActive(
  inventory: RecommendationRefillPollSnapshot,
  now = Date.now()
) {
  if (inventory.terminal) return false
  const jobActive =
    inventory.refillJob !== null &&
    activeJobStatuses.has(inventory.refillJob.status)
  const operationObservedAt =
    parseTime(inventory.serverUpdatedAt) ??
    parseTime(inventory.refillJob?.updatedAt)
  if (
    !jobActive &&
    (operationObservedAt === null ||
      now - operationObservedAt >= operationRecoveryGraceMs)
  ) {
    return false
  }
  return (
    inventory.refillInFlight ||
    inventory.refillState === "running" ||
    jobActive
  )
}

function snapshotFingerprint(inventory: RecommendationRefillPollSnapshot) {
  const job = inventory.refillJob
  return [
    inventory.operationId,
    inventory.stage,
    inventory.terminal,
    inventory.terminalState,
    inventory.publishedCount,
    inventory.serverUpdatedAt,
    inventory.refillState,
    job?.id,
    job?.status,
    job?.progress,
    job?.updatedAt,
  ].join(":")
}

const waitForInterval = (
  intervalMs: number,
  signal: AbortSignal
): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }

    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve(true)
    }, intervalMs)
    const abort = () => {
      window.clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener("abort", abort, { once: true })
  })

export async function pollRecommendationRefill<
  T extends RecommendationRefillPollSnapshot,
>(options: PollOptions<T>): Promise<"terminal" | "aborted" | "background"> {
  const sleep = options.sleep ?? waitForInterval
  const now = options.now ?? Date.now
  const maximumActivePollingMs = options.maximumActivePollingMs ?? 120_000
  const maximumConsecutiveErrors = options.maximumConsecutiveErrors ?? 8
  const startedAt = now()
  let backoffIndex = 0
  let consecutiveErrors = 0
  let previousFingerprint: string | null = null

  while (!options.signal.aborted) {
    if (now() - startedAt >= maximumActivePollingMs) {
      options.onBackgroundContinuation?.("timeout")
      return "background"
    }
    let inventory: T
    try {
      inventory = await options.getInventory(options.signal)
    } catch (error) {
      if (options.signal.aborted) return "aborted"
      consecutiveErrors += 1
      options.onError?.(error)
      if (consecutiveErrors >= maximumConsecutiveErrors) {
        options.onBackgroundContinuation?.("read_errors")
        return "background"
      }
      const delay =
        recommendationRefillPollDelaysMs[
          Math.min(backoffIndex, recommendationRefillPollDelaysMs.length - 1)
        ]
      backoffIndex += 1
      if (!(await sleep(delay, options.signal))) return "aborted"
      continue
    }

    if (options.signal.aborted) return "aborted"
    consecutiveErrors = 0
    options.onInventory(inventory)
    if (!options.shouldContinue(inventory)) {
      await options.onTerminal(inventory)
      return "terminal"
    }

    const fingerprint = snapshotFingerprint(inventory)
    backoffIndex =
      previousFingerprint !== null && fingerprint === previousFingerprint
        ? Math.min(
            backoffIndex + 1,
            recommendationRefillPollDelaysMs.length - 1
          )
        : 0
    previousFingerprint = fingerprint
    const delay = recommendationRefillPollDelaysMs[backoffIndex]
    if (!(await sleep(delay, options.signal))) return "aborted"
  }

  return "aborted"
}
