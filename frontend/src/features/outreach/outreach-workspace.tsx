import { useCurrentProject } from "@/app/project-context"
import { useGmailConnection } from "@/features/outreach/gmail/use-gmail-connection"
import { linksApi } from "@/features/outreach/links/api"
import { LinksWorkspace } from "@/features/outreach/links/links-workspace"
import { MailSyncStatusPanel } from "@/features/outreach/mail/mail-sync-status-panel"
import { OpportunitiesWorkspace } from "@/features/outreach/opportunities/opportunities-workspace"
import { RecommendationsWorkspace } from "@/features/outreach/recommendations/recommendations-workspace"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"
import { ProjectWorkspace } from "@/features/projects/project-workspace"

export function OutreachWorkspace({ view }: { view: string }) {
  const { currentProject } = useCurrentProject()
  if (!currentProject) {
    throw new Error("OutreachWorkspace requires an authorized current project.")
  }
  const projectId = currentProject.id
  const gmailConnection = useGmailConnection(projectId, view === "email")

  if (view === "projects") return <ProjectWorkspace />
  if (view === "recommendations") {
    return <RecommendationsWorkspace websiteProjectKey={projectId} />
  }
  if (view === "opportunities") {
    return <OpportunitiesWorkspace websiteProjectKey={projectId} />
  }
  if (view === "links") {
    return <LinksWorkspace client={linksApi} websiteProjectKey={projectId} />
  }
  if (view === "email") {
    return <MailSyncStatusPanel controller={gmailConnection} />
  }
  return (
    <OutreachStandardStateView
      state="error"
      title="页面不可用"
      description="当前 Outreach 路由未注册。"
    />
  )
}
