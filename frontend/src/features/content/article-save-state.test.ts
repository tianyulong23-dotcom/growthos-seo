import { describe, expect, it } from "vitest"

import {
  articleSaveReducer,
  initialArticleSaveState,
} from "@/features/content/article-save-state"

describe("article save state", () => {
  it("tracks dirty, local, server autosave, conflict and manual save states", () => {
    let state = initialArticleSaveState("base")

    state = articleSaveReducer(state, {
      type: "changed",
      hash: "draft-1",
      baselineHash: "base",
    })
    expect(state).toMatchObject({
      status: "autosave_pending",
      dirty: true,
      localProtected: false,
    })

    state = articleSaveReducer(state, { type: "local_saved", hash: "draft-1" })
    expect(state.localProtected).toBe(true)

    state = articleSaveReducer(state, { type: "autosave_started" })
    expect(state.status).toBe("autosaving")

    state = articleSaveReducer(state, {
      type: "autosave_succeeded",
      hash: "draft-1",
      autosaveId: "autosave-1",
      savedAt: "2026-08-08T00:00:00Z",
    })
    expect(state).toMatchObject({
      status: "autosaved",
      dirty: true,
      protectedHash: "draft-1",
      autosaveId: "autosave-1",
    })

    state = articleSaveReducer(state, {
      type: "conflict",
      error: "conflict",
    })
    expect(state).toMatchObject({ status: "conflict", error: "conflict" })

    state = articleSaveReducer(state, {
      type: "manual_saved",
      hash: "draft-1",
      hasNewerChanges: false,
    })
    expect(state).toMatchObject({
      status: "saved",
      dirty: false,
      autosaveId: null,
    })
  })

  it("does not report a newer hash as locally protected", () => {
    let state = initialArticleSaveState("base")
    state = articleSaveReducer(state, {
      type: "changed",
      hash: "draft-1",
      baselineHash: "base",
    })
    state = articleSaveReducer(state, { type: "local_saved", hash: "draft-1" })
    state = articleSaveReducer(state, {
      type: "changed",
      hash: "draft-2",
      baselineHash: "base",
    })
    state = articleSaveReducer(state, {
      type: "autosave_failed",
      error: "offline",
    })

    expect(state).toMatchObject({
      status: "failed",
      localProtected: false,
      currentHash: "draft-2",
    })
  })

  it("ignores stale local and server save acknowledgements", () => {
    const state = articleSaveReducer(initialArticleSaveState("base"), {
      type: "changed",
      hash: "newest",
      baselineHash: "base",
    })

    const staleLocal = articleSaveReducer(state, {
      type: "local_saved",
      hash: "older",
    })
    const staleServer = articleSaveReducer(state, {
      type: "autosave_succeeded",
      hash: "older",
      autosaveId: "old-autosave",
      savedAt: "2026-08-08T00:00:00Z",
    })

    expect(staleLocal).toBe(state)
    expect(staleServer).toBe(state)
  })

  it("distinguishes local-only protection from an unprotected failure", () => {
    const dirty = articleSaveReducer(initialArticleSaveState("base"), {
      type: "changed",
      hash: "draft",
      baselineHash: "base",
    })
    const unprotected = articleSaveReducer(dirty, {
      type: "unauthorized",
    })
    const protectedState = articleSaveReducer(
      articleSaveReducer(dirty, { type: "local_saved", hash: "draft" }),
      { type: "autosave_failed", error: "offline" }
    )

    expect(unprotected.status).toBe("failed")
    expect(protectedState.status).toBe("local_only")
  })
})
