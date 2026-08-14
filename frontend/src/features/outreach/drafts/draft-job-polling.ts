export type DraftJobPollSnapshot = Readonly<{
  id: string
  draftId: string
  status:
    | "QUEUED"
    | "RUNNING"
    | "RETRY_SCHEDULED"
    | "SUCCEEDED"
    | "FAILED"
    | "REFUSED"
  deadlineAt: string
}>

type PollResult<T extends DraftJobPollSnapshot> =
  | Readonly<{ reason: "terminal"; job: T }>
  | Readonly<{ reason: "stale"; job: T }>
  | Readonly<{ reason: "aborted"; job: null }>

type PollOptions<T extends DraftJobPollSnapshot> = Readonly<{
  signal: AbortSignal
  intervalMs: number
  getJob(signal: AbortSignal): Promise<T>
  onJob(job: T): void
  onError?(error: unknown): void
  now?: () => number
  sleep?: (intervalMs: number, signal: AbortSignal) => Promise<boolean>
}>

const terminalStatuses = new Set<DraftJobPollSnapshot["status"]>([
  "SUCCEEDED",
  "FAILED",
  "REFUSED",
])

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

export async function pollDraftJob<T extends DraftJobPollSnapshot>(
  options: PollOptions<T>
): Promise<PollResult<T>> {
  const sleep = options.sleep ?? waitForInterval
  const now = options.now ?? Date.now
  let latestJob: T | null = null

  while (!options.signal.aborted) {
    if (!(await sleep(options.intervalMs, options.signal))) {
      return { reason: "aborted", job: null }
    }

    let job: T
    try {
      job = await options.getJob(options.signal)
    } catch (error) {
      if (options.signal.aborted) {
        return { reason: "aborted", job: null }
      }
      if (latestJob === null) throw error
      options.onError?.(error)
      const deadline = Date.parse(latestJob.deadlineAt)
      if (Number.isFinite(deadline) && now() >= deadline) {
        return { reason: "stale", job: latestJob }
      }
      continue
    }
    latestJob = job
    options.onJob(job)

    if (terminalStatuses.has(job.status)) {
      return { reason: "terminal", job }
    }
    const deadline = Date.parse(job.deadlineAt)
    if (Number.isFinite(deadline) && now() >= deadline) {
      return { reason: "stale", job }
    }
  }

  return { reason: "aborted", job: null }
}
