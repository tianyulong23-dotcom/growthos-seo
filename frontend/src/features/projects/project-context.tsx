/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

import {
  createProject as createProjectRequest,
  deleteProject as deleteProjectRequest,
  getProject as getProjectRequest,
  listProjects,
  refreshBusinessProfile as refreshBusinessProfileRequest,
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
  createProject: (input: CreateProjectInput) => Promise<Project>
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
  const [projects, setProjects] = React.useState<Project[]>([])
  const deletedProjectIds = React.useRef(new Set<string>())

  React.useEffect(() => {
    let active = true
    void listProjects()
      .then((loadedProjects) => {
        if (active) {
          setProjects(loadedProjects)
        }
      })
      .catch(() => {
        // The create dialog will show API errors. Keep the project list empty.
      })
    return () => {
      active = false
    }
  }, [])

  const createProject = React.useCallback(async (input: CreateProjectInput) => {
    const project = await createProjectRequest(input)
    setProjects((current) => [project, ...current])
    return project
  }, [])

  const deleteProject = React.useCallback(async (projectId: string) => {
    deletedProjectIds.current.add(projectId)
    try {
      await deleteProjectRequest(projectId)
      setProjects((current) =>
        current.filter((project) => project.id !== projectId)
      )
    } catch (error) {
      deletedProjectIds.current.delete(projectId)
      throw error
    }
  }, [])

  const getProject = React.useCallback(
    (projectId?: string) =>
      projects.find((project) => project.id === projectId) ??
      projects[0] ??
      emptyProject,
    [projects]
  )

  const refreshProject = React.useCallback(async (projectId: string) => {
    const project = await getProjectRequest(projectId)
    if (deletedProjectIds.current.has(projectId)) {
      return project
    }
    setProjects((current) => {
      const exists = current.some((item) => item.id === project.id)
      if (!exists) {
        return [project, ...current]
      }
      return current.map((item) => (item.id === project.id ? project : item))
    })
    return project
  }, [])

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
        projectIds.map((projectId) => refreshProject(projectId))
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
  }, [activeUnderstandingProjectKey, refreshProject])

  const updateProject = React.useCallback(
    (
      projectId: string,
      changes: Partial<Pick<Project, "domain" | "country" | "language">>
    ) => {
      setProjects((current) =>
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
      setProjects((current) =>
        current.map((item) => (item.id === project.id ? project : item))
      )
      return project
    },
    []
  )

  const refreshBusinessProfile = React.useCallback(
    async (projectId: string) => {
      const project = await refreshBusinessProfileRequest(projectId)
      setProjects((current) =>
        current.map((item) => (item.id === project.id ? project : item))
      )
      return project
    },
    []
  )

  const value = React.useMemo(
    () => ({
      projects,
      createProject,
      deleteProject,
      getProject,
      refreshProject,
      updateProject,
      updateBusinessProfile,
      refreshBusinessProfile,
    }),
    [
      projects,
      createProject,
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
