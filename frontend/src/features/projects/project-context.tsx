/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

import {
  archiveProject as archiveProjectRequest,
  createProject as createProjectRequest,
  deleteProject as deleteProjectRequest,
  getProject as getProjectRequest,
  listProjects,
  refreshBusinessProfile as refreshBusinessProfileRequest,
  restoreProject as restoreProjectRequest,
  updateBusinessProfile as updateBusinessProfileRequest,
} from "@/api/projects"
import type { BusinessProfileInput, Project } from "@/features/projects/types"

type CreateProjectInput = {
  domain: string
  country: string
  language: string
  competitorDomain?: string
}

type ProjectContextValue = {
  projects: Project[]
  archivedProjects: Project[]
  loadState: "loading" | "ready" | "error"
  createProject: (input: CreateProjectInput) => Promise<Project>
  archiveProject: (projectId: string) => Promise<Project>
  restoreProject: (projectId: string) => Promise<Project>
  deleteProject: (projectId: string) => Promise<void>
  getProject: (projectId?: string) => Project
  refreshProject: (projectId: string) => Promise<Project>
  updateProject: (
    projectId: string,
    changes: Partial<Pick<Project, "domain" | "country" | "language">>
  ) => void
  updateBusinessProfile: (
    projectId: string,
    input: BusinessProfileInput
  ) => Promise<Project>
  refreshBusinessProfile: (projectId: string) => Promise<Project>
}

const ProjectContext = React.createContext<ProjectContextValue | undefined>(
  undefined
)

const emptyProject: Project = {
  id: "",
  name: "",
  domain: "",
  country: "",
  language: "",
  competitorDomain: null,
  understandingRunId: null,
  understandingStatus: null,
  understandingStage: null,
  understandingMessage: "",
  understandingProgress: 0,
  understandingAttempt: 1,
  understandingStartedAt: null,
  understandingFinishedAt: null,
  understandingElapsedSeconds: 0,
  auditRunId: null,
  auditStatus: "never_started",
  auditHealth: null,
  siteProfile: null,
  createdAt: "",
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [allProjects, setAllProjects] = React.useState<Project[]>([])
  const [loadState, setLoadState] =
    React.useState<ProjectContextValue["loadState"]>("loading")
  const deletedProjectIds = React.useRef(new Set<string>())

  React.useEffect(() => {
    let active = true
    void Promise.all([listProjects("ACTIVE"), listProjects("ARCHIVED")])
      .then(([activeProjects, archivedProjects]) => {
        if (active) {
          const loadedProjects = [...activeProjects, ...archivedProjects]
          setAllProjects(
            Array.from(
              new Map(
                loadedProjects
                  .filter(
                    (project) => !deletedProjectIds.current.has(project.id)
                  )
                  .map((project) => [project.id, project])
              ).values()
            )
          )
          setLoadState("ready")
        }
      })
      .catch(() => {
        if (active) {
          setLoadState("error")
        }
      })
    return () => {
      active = false
    }
  }, [])

  const createProject = React.useCallback(async (input: CreateProjectInput) => {
    const project = await createProjectRequest(input)
    setAllProjects((current) => [project, ...current])
    setLoadState("ready")
    return project
  }, [])

  const deleteProject = React.useCallback(async (projectId: string) => {
    deletedProjectIds.current.add(projectId)
    try {
      await deleteProjectRequest(projectId)
      setAllProjects((current) =>
        current.filter((project) => project.id !== projectId)
      )
    } catch (error) {
      deletedProjectIds.current.delete(projectId)
      throw error
    }
  }, [])

  const applyProject = React.useCallback((project: Project) => {
    setAllProjects((current) =>
      current.map((item) => (item.id === project.id ? project : item))
    )
    return project
  }, [])

  const archiveProject = React.useCallback(
    async (projectId: string) =>
      applyProject(await archiveProjectRequest(projectId)),
    [applyProject]
  )

  const restoreProject = React.useCallback(
    async (projectId: string) =>
      applyProject(await restoreProjectRequest(projectId)),
    [applyProject]
  )

  const projects = React.useMemo(
    () =>
      allProjects.filter(
        (project) => (project.lifecycleStatus ?? "ACTIVE") === "ACTIVE"
      ),
    [allProjects]
  )
  const archivedProjects = React.useMemo(
    () =>
      allProjects.filter((project) => project.lifecycleStatus === "ARCHIVED"),
    [allProjects]
  )

  const getProject = React.useCallback(
    (projectId?: string) =>
      allProjects.find((project) => project.id === projectId) ?? emptyProject,
    [allProjects]
  )

  const loadProject = React.useCallback(
    async (projectId: string, shouldApply: () => boolean) => {
      const project = await getProjectRequest(projectId)
      if (project.id !== projectId) {
        throw new Error(
          "Project response does not match the requested project."
        )
      }
      if (!shouldApply() || deletedProjectIds.current.has(projectId)) {
        return project
      }
      setAllProjects((current) => {
        const exists = current.some((item) => item.id === project.id)
        if (!exists) {
          return [project, ...current]
        }
        return current.map((item) => (item.id === project.id ? project : item))
      })
      return project
    },
    []
  )

  const refreshProject = React.useCallback(
    (projectId: string) => loadProject(projectId, () => true),
    [loadProject]
  )

  const activeUnderstandingProjectIds = React.useMemo(
    () =>
      projects
        .filter(
          (project) =>
            project.understandingStatus === "queued" ||
            project.understandingStatus === "running"
        )
        .map((project) => project.id)
        .sort(),
    [projects]
  )
  const activeUnderstandingProjectKey =
    activeUnderstandingProjectIds.join("\u0000")

  React.useEffect(() => {
    if (!activeUnderstandingProjectKey) {
      return
    }

    const projectIds = activeUnderstandingProjectKey.split("\u0000")
    let active = true
    let timer = 0

    async function poll() {
      await Promise.allSettled(
        projectIds.map((projectId) => loadProject(projectId, () => active))
      )
      if (active) {
        timer = window.setTimeout(() => {
          void poll()
        }, 1200)
      }
    }

    timer = window.setTimeout(() => {
      void poll()
    }, 600)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [activeUnderstandingProjectKey, loadProject])

  const updateProject = React.useCallback(
    (
      projectId: string,
      changes: Partial<Pick<Project, "domain" | "country" | "language">>
    ) => {
      setAllProjects((current) =>
        current.map((project) =>
          project.id === projectId ? { ...project, ...changes } : project
        )
      )
    },
    []
  )

  const updateBusinessProfile = React.useCallback(
    async (projectId: string, input: BusinessProfileInput) => {
      const project = await updateBusinessProfileRequest(projectId, input)
      if (project.id !== projectId) {
        throw new Error(
          "Business profile response does not match the requested project."
        )
      }
      setAllProjects((current) =>
        current.map((item) => (item.id === project.id ? project : item))
      )
      return project
    },
    []
  )

  const refreshBusinessProfile = React.useCallback(
    async (projectId: string) => {
      const project = await refreshBusinessProfileRequest(projectId)
      if (project.id !== projectId) {
        throw new Error(
          "Business profile response does not match the requested project."
        )
      }
      setAllProjects((current) =>
        current.map((item) => (item.id === project.id ? project : item))
      )
      return project
    },
    []
  )

  const value = React.useMemo(
    () => ({
      projects,
      archivedProjects,
      loadState,
      createProject,
      archiveProject,
      restoreProject,
      deleteProject,
      getProject,
      refreshProject,
      updateProject,
      updateBusinessProfile,
      refreshBusinessProfile,
    }),
    [
      projects,
      archivedProjects,
      loadState,
      createProject,
      archiveProject,
      restoreProject,
      deleteProject,
      getProject,
      refreshProject,
      updateProject,
      updateBusinessProfile,
      refreshBusinessProfile,
    ]
  )

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  )
}

export function useProjects() {
  const context = React.useContext(ProjectContext)
  if (!context) {
    throw new Error("useProjects must be used within ProjectProvider")
  }
  return context
}
