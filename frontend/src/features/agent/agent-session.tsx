/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { useParams, useSearchParams } from "react-router"

import { useProjects } from "@/features/projects/project-context"
import { useAgentConversation } from "./use-agent-conversation"

const AgentSession = React.createContext<ReturnType<typeof useAgentConversation> | null>(null)

export function AgentSessionProvider({ children }: { children: React.ReactNode }) {
  const { projectId = "" } = useParams()
  const [params] = useSearchParams()
  const { getProject } = useProjects()
  const project = getProject(projectId)
  const agent = useAgentConversation(
    project.id, project.understandingStatus, params.get("agentConversation") ?? undefined
  )
  return <AgentSession.Provider value={agent}>{children}</AgentSession.Provider>
}

export function useAgentSession() {
  const session = React.useContext(AgentSession)
  if (!session) throw new Error("AgentSessionProvider is required")
  return session
}
