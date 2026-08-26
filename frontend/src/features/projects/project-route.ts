export function projectRouteForSwitch(
  pathname: string,
  currentProjectId: string,
  nextProjectId: string
) {
  const projectPrefix = `/projects/${currentProjectId}`
  const suffix = pathname.startsWith(projectPrefix)
    ? pathname.slice(projectPrefix.length)
    : ""
  if (suffix.startsWith("/backlinks/drafts/")) {
    return `/projects/${nextProjectId}/backlinks/email`
  }
  return `/projects/${nextProjectId}${suffix || "/audit/overview"}`
}
