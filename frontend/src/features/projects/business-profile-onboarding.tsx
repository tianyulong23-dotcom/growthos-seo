import * as React from "react"
import { useLocation, useNavigate, useParams } from "react-router"

import {
  clearBusinessProfileOnboarding,
  hasBusinessProfileOnboarding,
} from "@/features/projects/business-profile-onboarding-storage"
import { useProjects } from "@/features/projects/project-context"

export function BusinessProfileOnboardingController() {
  const location = useLocation()
  const navigate = useNavigate()
  const { projectId = "" } = useParams()
  const { getProject } = useProjects()
  const project = getProject(projectId)
  const waitFromNavigation = Boolean(
    (location.state as { waitForBusinessProfile?: boolean } | null)
      ?.waitForBusinessProfile
  )
  const following =
    waitFromNavigation || hasBusinessProfileOnboarding(projectId)

  React.useEffect(() => {
    if (!following || !projectId) {
      return
    }

    if (
      project.siteProfile &&
      (project.understandingStatus === "completed" ||
        project.understandingStatus === "partial")
    ) {
      clearBusinessProfileOnboarding(projectId)
      navigate(`/projects/${projectId}/settings/business`, {
        replace: true,
      })
      return
    }

    if (
      !project.siteProfile &&
      (project.understandingStatus === "failed" ||
        project.understandingStatus === "completed" ||
        project.understandingStatus === "partial")
    ) {
      clearBusinessProfileOnboarding(projectId)
      navigate(location.pathname, {
        replace: true,
        state: null,
      })
    }
  }, [
    following,
    location.pathname,
    navigate,
    project.siteProfile,
    project.understandingStatus,
    projectId,
  ])

  return null
}
