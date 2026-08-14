import assert from "node:assert/strict"
import test from "node:test"

import {
  readRecommendationOperation,
  releaseRecommendationStartLease,
  storeRecommendationOperation,
  tryAcquireRecommendationStartLease,
} from "./recommendation-operation-session.ts"

class MemoryStorage {
  values = new Map()

  getItem(key) {
    return this.values.get(key) ?? null
  }

  setItem(key, value) {
    this.values.set(key, String(value))
  }

  removeItem(key) {
    this.values.delete(key)
  }
}

const scope = {
  websiteProjectKey: "project-alpha",
  recommendationContextVersionId: "context-v3",
  visiblePoolGeneration: 1,
}
const operationId = "018f0000-0000-7000-8000-000000000097"

test("LOCAL-PRODUCT-037 persists one operation per project context", () => {
  const storage = new MemoryStorage()
  storeRecommendationOperation(storage, scope, operationId)

  assert.equal(
    readRecommendationOperation(storage, scope),
    operationId
  )
  assert.equal(
    readRecommendationOperation(storage, {
      ...scope,
      websiteProjectKey: "project-beta",
    }),
    null
  )
  assert.equal(
    readRecommendationOperation(storage, {
      ...scope,
      visiblePoolGeneration: 2,
    }),
    null
  )
})

test("discarding a malformed stored operation allows a fresh generation", () => {
  const storage = new MemoryStorage()
  storeRecommendationOperation(storage, scope, "operation-from-old-client")

  assert.equal(readRecommendationOperation(storage, scope), null)
  assert.equal(
    storage.getItem(
      "growthos:recommendation-refill:project-alpha:context-v3:g1"
    ),
    null
  )
})

test("LOCAL-PRODUCT-037 prevents concurrent tabs from starting a second operation", () => {
  const storage = new MemoryStorage()

  assert.equal(
    tryAcquireRecommendationStartLease(storage, scope, "tab-a", 1_000),
    true
  )
  assert.equal(
    tryAcquireRecommendationStartLease(storage, scope, "tab-b", 1_001),
    false
  )

  releaseRecommendationStartLease(storage, scope, "tab-a")
  assert.equal(
    tryAcquireRecommendationStartLease(storage, scope, "tab-b", 1_002),
    true
  )
})

test("LOCAL-PRODUCT-037 permits recovery from an expired browser lease", () => {
  const storage = new MemoryStorage()

  assert.equal(
    tryAcquireRecommendationStartLease(storage, scope, "closed-tab", 2_000),
    true
  )
  assert.equal(
    tryAcquireRecommendationStartLease(storage, scope, "new-tab", 17_001),
    true
  )
})
