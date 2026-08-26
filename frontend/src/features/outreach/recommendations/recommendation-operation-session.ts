type RecommendationOperationScope = Readonly<{
  websiteProjectKey: string
  recommendationContextVersionId: string
  visiblePoolGeneration: number
}>

type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">

type StartLease = Readonly<{
  ownerId: string
  expiresAt: number
}>

const startLeaseTtlMs = 15_000
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function recommendationOperationStorageKey(
  scope: RecommendationOperationScope
) {
  return `growthos:recommendation-refill:${scope.websiteProjectKey}:${scope.recommendationContextVersionId}:g${scope.visiblePoolGeneration}`
}

function recommendationStartLeaseStorageKey(
  scope: RecommendationOperationScope
) {
  return `${recommendationOperationStorageKey(scope)}:start-lease`
}

function recommendationRefillAttemptStorageKey(
  scope: RecommendationOperationScope
) {
  return `${recommendationOperationStorageKey(scope)}:attempt`
}

export function readRecommendationOperation(
  storage: StorageAccess,
  scope: RecommendationOperationScope
) {
  const key = recommendationOperationStorageKey(scope)
  const operationId = storage.getItem(key)
  if (operationId === null || uuidPattern.test(operationId)) {
    return operationId
  }
  storage.removeItem(key)
  return null
}

export function storeRecommendationOperation(
  storage: StorageAccess,
  scope: RecommendationOperationScope,
  operationId: string
) {
  storage.setItem(recommendationOperationStorageKey(scope), operationId)
}

export function clearRecommendationOperation(
  storage: StorageAccess,
  scope: RecommendationOperationScope
) {
  storage.removeItem(recommendationOperationStorageKey(scope))
}

export function getOrCreateRecommendationRefillAttempt(
  storage: StorageAccess,
  scope: RecommendationOperationScope,
  createAttemptId: () => string
) {
  const key = recommendationRefillAttemptStorageKey(scope)
  const storedAttemptId = storage.getItem(key)
  if (storedAttemptId !== null && uuidPattern.test(storedAttemptId)) {
    return storedAttemptId
  }
  if (storedAttemptId !== null) storage.removeItem(key)

  const attemptId = createAttemptId()
  storage.setItem(key, attemptId)
  return attemptId
}

export function clearRecommendationRefillAttempt(
  storage: StorageAccess,
  scope: RecommendationOperationScope
) {
  storage.removeItem(recommendationRefillAttemptStorageKey(scope))
}

function parseStartLease(value: string | null): StartLease | null {
  if (value === null) return null
  try {
    const parsed = JSON.parse(value) as Partial<StartLease>
    return typeof parsed.ownerId === "string" &&
      typeof parsed.expiresAt === "number"
      ? { ownerId: parsed.ownerId, expiresAt: parsed.expiresAt }
      : null
  } catch {
    return null
  }
}

export function tryAcquireRecommendationStartLease(
  storage: StorageAccess,
  scope: RecommendationOperationScope,
  ownerId: string,
  now = Date.now()
) {
  const key = recommendationStartLeaseStorageKey(scope)
  const current = parseStartLease(storage.getItem(key))
  if (
    current !== null &&
    current.ownerId !== ownerId &&
    current.expiresAt > now
  ) {
    return false
  }

  const lease = { ownerId, expiresAt: now + startLeaseTtlMs }
  storage.setItem(key, JSON.stringify(lease))
  const stored = parseStartLease(storage.getItem(key))
  return stored?.ownerId === ownerId && stored.expiresAt === lease.expiresAt
}

export function releaseRecommendationStartLease(
  storage: StorageAccess,
  scope: RecommendationOperationScope,
  ownerId: string
) {
  const key = recommendationStartLeaseStorageKey(scope)
  const current = parseStartLease(storage.getItem(key))
  if (current?.ownerId === ownerId) storage.removeItem(key)
}

export function subscribeRecommendationOperation(
  scope: RecommendationOperationScope,
  onOperationChanged: (operationId: string | null) => void
) {
  const key = recommendationOperationStorageKey(scope)
  const listener = (event: StorageEvent) => {
    if (event.storageArea === window.localStorage && event.key === key) {
      onOperationChanged(event.newValue)
    }
  }
  window.addEventListener("storage", listener)
  return () => window.removeEventListener("storage", listener)
}
