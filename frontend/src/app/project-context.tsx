/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { useLocation, useNavigate } from "react-router"

import {
  requestPlatform,
  type WebsiteProjectMutationResponse,
  type WebsiteProjectProfilePatchRequest,
  type WebsiteProjectProfileRequest,
  type WebsiteProjectResponse,
} from "@/api/generated/platform"
import { backlinksProjectQueries } from "@/features/outreach/api/project-query"

export type Project = {
  id: string
  websiteProjectId: string
  status: "ACTIVE" | "ARCHIVED"
  archivedAt: string | null
  name: string
  domain: string
  country: string
  targetMarket: string
  language: string
  health: number
  contextVersion: number
  profileVersionId: string
  promotionTargetVersionId: string
  keywords: readonly string[]
  products: readonly string[]
  targetUrls: readonly string[]
  inputRequired: readonly ("keywords" | "products" | "target_urls")[]
  createdAt: string
  updatedAt: string
}

export type ProjectMutation = {
  project: Project
  backgroundStatus: WebsiteProjectMutationResponse["background_status"]
}

type CurrentProjectValue = {
  projects: readonly Project[]
  archivedProjects: readonly Project[]
  currentProject: Project | null
  defaultProject: Project | null
  loading: boolean
  error: Error | null
  refreshProjects: () => Promise<readonly Project[]>
  createProject: (
    profile: WebsiteProjectProfileRequest
  ) => Promise<ProjectMutation>
  updateProject: (
    websiteProjectKey: string,
    profile: WebsiteProjectProfilePatchRequest
  ) => Promise<ProjectMutation>
  archiveProject: (websiteProjectKey: string) => Promise<ProjectMutation>
  restoreProject: (websiteProjectKey: string) => Promise<ProjectMutation>
  switchProject: (websiteProjectKey: string) => void
}

const CurrentProjectContext = React.createContext<CurrentProjectValue | null>(
  null
)

function toProject(project: WebsiteProjectResponse): Project {
  return {
    id: project.website_project_key,
    websiteProjectId: project.id,
    status: project.status,
    archivedAt: project.archived_at,
    name: project.name,
    domain: project.domain,
    country: project.country,
    targetMarket: project.target_market,
    language: project.language,
    health: project.health,
    contextVersion: project.context_version,
    profileVersionId: project.profile_version_id,
    promotionTargetVersionId: project.promotion_target_version_id,
    keywords: project.keywords,
    products: project.products,
    targetUrls: project.target_urls,
    inputRequired: project.input_required,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  }
}

function toMutation(result: WebsiteProjectMutationResponse): ProjectMutation {
  return {
    project: toProject(result.project),
    backgroundStatus: result.background_status,
  }
}

function projectKeyFromPath(pathname: string) {
  const match = pathname.match(/^\/projects\/([^/]+)/)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

async function fetchProjects(signal: AbortSignal) {
  const response = await requestPlatform(
    "platformListWebsiteProjectsV1",
    { query: { include_archived: true } },
    { signal }
  )
  return response.map(toProject)
}

export function CurrentProjectProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [allProjects, setAllProjects] = React.useState<readonly Project[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<Error | null>(null)
  const requestRef = React.useRef<AbortController | null>(null)
  const projectsRef = React.useRef<readonly Project[]>([])
  const securityErrorRef = React.useRef<string | null>(null)

  const refreshProjects = React.useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    try {
      const next = await fetchProjects(controller.signal)
      if (controller.signal.aborted || requestRef.current !== controller) {
        throw new DOMException("Project request superseded", "AbortError")
      }
      projectsRef.current = next
      setAllProjects(next)
      setError(null)
      return next
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        throw cause
      }
      const nextError =
        cause instanceof Error ? cause : new Error("Website Projects 加载失败。")
      setError(nextError)
      throw nextError
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null
        setLoading(false)
      }
    }
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    requestRef.current = controller
    void fetchProjects(controller.signal)
      .then((next) => {
        if (controller.signal.aborted || requestRef.current !== controller) {
          return
        }
        projectsRef.current = next
        setAllProjects(next)
        setError(null)
      })
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          const nextError =
            cause instanceof Error
              ? cause
              : new Error("Website Projects 加载失败。")
          setError(nextError)
          console.error("Website Project authority request failed.", cause)
        }
      })
      .finally(() => {
        if (requestRef.current === controller) {
          requestRef.current = null
          setLoading(false)
        }
      })
    return () => {
      controller.abort()
      if (requestRef.current === controller) {
        requestRef.current = null
      }
    }
  }, [])

  const projects = React.useMemo(
    () => allProjects.filter((project) => project.status === "ACTIVE"),
    [allProjects]
  )
  const archivedProjects = React.useMemo(
    () => allProjects.filter((project) => project.status === "ARCHIVED"),
    [allProjects]
  )
  const configuredDefault =
    import.meta.env.VITE_WEBSITE_PROJECT_KEY?.trim() ?? ""
  const defaultProject =
    projects.find((project) => project.id === configuredDefault) ??
    projects[0] ??
    null
  const routeProjectKey = projectKeyFromPath(location.pathname)
  const currentProject =
    projects.find((project) => project.id === routeProjectKey) ?? null

  React.useEffect(() => {
    if (routeProjectKey) {
      backlinksProjectQueries.activateProject(routeProjectKey)
    }
  }, [routeProjectKey])

  React.useEffect(() => {
    if (
      loading ||
      error ||
      !routeProjectKey ||
      currentProject ||
      securityErrorRef.current === routeProjectKey
    ) {
      return
    }
    securityErrorRef.current = routeProjectKey
    console.error(
      `Rejected Website Project route outside the authorized active list: ${routeProjectKey}`
    )
  }, [currentProject, error, loading, routeProjectKey])

  const mutate = React.useCallback(
    async (
      request: Promise<WebsiteProjectMutationResponse>
    ): Promise<ProjectMutation> => {
      const result = await request
      await refreshProjects()
      return toMutation(result)
    },
    [refreshProjects]
  )

  const createProject = React.useCallback(
    (profile: WebsiteProjectProfileRequest) =>
      mutate(
        requestPlatform("platformCreateWebsiteProjectV1", {
          body: profile,
        })
      ),
    [mutate]
  )
  const updateProject = React.useCallback(
    (
      websiteProjectKey: string,
      profile: WebsiteProjectProfilePatchRequest
    ) =>
      mutate(
        requestPlatform("platformUpdateWebsiteProjectV1", {
          path: { websiteProjectKey },
          body: profile,
        })
      ),
    [mutate]
  )
  const archiveProject = React.useCallback(
    (websiteProjectKey: string) =>
      mutate(
        requestPlatform("platformArchiveWebsiteProjectV1", {
          path: { websiteProjectKey },
        })
      ),
    [mutate]
  )
  const restoreProject = React.useCallback(
    (websiteProjectKey: string) =>
      mutate(
        requestPlatform("platformRestoreWebsiteProjectV1", {
          path: { websiteProjectKey },
        })
      ),
    [mutate]
  )
  const switchProject = React.useCallback(
    (websiteProjectKey: string) => {
      const target = projectsRef.current.find(
        (project) =>
          project.id === websiteProjectKey && project.status === "ACTIVE"
      )
      if (!target) {
        console.error(
          `Rejected Website Project switch outside the authorized active list: ${websiteProjectKey}`
        )
        return
      }
      backlinksProjectQueries.activateProject(websiteProjectKey)
      const currentKey = projectKeyFromPath(location.pathname)
      const suffix = currentKey
        ? location.pathname
            .replace(`/projects/${encodeURIComponent(currentKey)}`, "")
            .replace(/^\/+/, "")
        : "overview"
      navigate(
        `/projects/${encodeURIComponent(websiteProjectKey)}/${suffix || "overview"}`
      )
    },
    [location.pathname, navigate]
  )

  return (
    <CurrentProjectContext.Provider
      value={{
        projects,
        archivedProjects,
        currentProject,
        defaultProject,
        loading,
        error,
        refreshProjects,
        createProject,
        updateProject,
        archiveProject,
        restoreProject,
        switchProject,
      }}
    >
      {children}
    </CurrentProjectContext.Provider>
  )
}

export function useCurrentProject() {
  const context = React.useContext(CurrentProjectContext)
  if (!context) {
    throw new Error(
      "useCurrentProject must be used inside CurrentProjectProvider."
    )
  }
  return context
}
