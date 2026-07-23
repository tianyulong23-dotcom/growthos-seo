const storageKeyPrefix = "seo:business-profile-onboarding:"

function storageKey(projectId: string) {
  return `${storageKeyPrefix}${projectId}`
}

export function markBusinessProfileOnboarding(projectId: string) {
  try {
    window.sessionStorage.setItem(storageKey(projectId), "pending")
  } catch {
    // Navigation state still preserves onboarding when storage is unavailable.
  }
}

export function hasBusinessProfileOnboarding(projectId: string) {
  try {
    return window.sessionStorage.getItem(storageKey(projectId)) === "pending"
  } catch {
    return false
  }
}

export function clearBusinessProfileOnboarding(projectId: string) {
  try {
    window.sessionStorage.removeItem(storageKey(projectId))
  } catch {
    // The next navigation also clears the in-memory onboarding state.
  }
}
