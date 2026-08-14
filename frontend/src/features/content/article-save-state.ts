export type ArticleSaveStatus =
  | "saved"
  | "dirty"
  | "autosave_pending"
  | "autosaving"
  | "autosaved"
  | "local_only"
  | "conflict"
  | "failed"

export type ArticleSaveState = {
  status: ArticleSaveStatus
  dirty: boolean
  localProtected: boolean
  currentHash: string
  protectedHash: string
  autosaveId: string | null
  savedAt: string | null
  error: string | null
}

export type ArticleSaveAction =
  | { type: "changed"; hash: string; baselineHash: string }
  | { type: "local_saved"; hash: string }
  | { type: "autosave_started" }
  | { type: "autosave_succeeded"; hash: string; autosaveId: string; savedAt: string }
  | { type: "autosave_failed"; error: string }
  | { type: "unauthorized" }
  | { type: "conflict"; error: string }
  | { type: "manual_saved"; hash: string; hasNewerChanges: boolean }
  | { type: "reset"; hash: string }

export function initialArticleSaveState(hash: string): ArticleSaveState {
  return {
    status: "saved",
    dirty: false,
    localProtected: false,
    currentHash: hash,
    protectedHash: hash,
    autosaveId: null,
    savedAt: null,
    error: null,
  }
}

export function articleSaveReducer(
  state: ArticleSaveState,
  action: ArticleSaveAction
): ArticleSaveState {
  switch (action.type) {
    case "changed": {
      const dirty = action.hash !== action.baselineHash
      const currentHashWasProtected =
        state.localProtected && state.currentHash === action.hash
      return {
        ...state,
        status: dirty ? "autosave_pending" : "saved",
        dirty,
        localProtected: dirty && currentHashWasProtected,
        currentHash: action.hash,
        error: null,
      }
    }
    case "local_saved":
      if (action.hash !== state.currentHash) return state
      return {
        ...state,
        localProtected: true,
        status:
          state.status === "failed" || state.status === "local_only"
            ? "local_only"
            : state.status,
      }
    case "autosave_started":
      return { ...state, status: "autosaving", error: null }
    case "autosave_succeeded":
      if (action.hash !== state.currentHash) return state
      return {
        ...state,
        status: "autosaved",
        dirty: true,
        protectedHash: action.hash,
        autosaveId: action.autosaveId,
        savedAt: action.savedAt,
        error: null,
      }
    case "autosave_failed":
      return {
        ...state,
        status: state.localProtected ? "local_only" : "failed",
        error: action.error,
      }
    case "unauthorized":
      return {
        ...state,
        status: state.localProtected ? "local_only" : "failed",
        error: "登录状态已失效，自动保存已暂停",
      }
    case "conflict":
      return { ...state, status: "conflict", error: action.error }
    case "manual_saved":
      return {
        ...state,
        status: action.hasNewerChanges ? "autosave_pending" : "saved",
        dirty: action.hasNewerChanges,
        localProtected: action.hasNewerChanges && state.localProtected,
        protectedHash: action.hash,
        autosaveId: null,
        savedAt: new Date().toISOString(),
        error: null,
      }
    case "reset":
      return initialArticleSaveState(action.hash)
  }
}

export const articleSaveStatusLabel: Record<ArticleSaveStatus, string> = {
  saved: "版本已保存",
  dirty: "有未保存修改",
  autosave_pending: "等待自动保存",
  autosaving: "正在自动保存",
  autosaved: "已自动保存到服务器",
  local_only: "仅本地保护",
  conflict: "保存冲突",
  failed: "修改尚未保护",
}
