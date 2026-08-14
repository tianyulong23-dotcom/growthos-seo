import { useGmailConnection } from "@/features/outreach/gmail/use-gmail-connection"
import { linksApi } from "@/features/outreach/links/api"
import { LinksWorkspace } from "@/features/outreach/links/links-workspace"
import { MailSyncStatusPanel } from "@/features/outreach/mail/mail-sync-status-panel"
import { OpportunitiesWorkspace } from "@/features/outreach/opportunities/opportunities-workspace"
import { toOutreachProject } from "@/features/outreach/project"
import { RecommendationsWorkspace } from "@/features/outreach/recommendations/recommendations-workspace"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"
import type { Project } from "@/features/projects/types"

export function OutreachWorkspace({
  view,
  project,
}: {
  view: string
  project: Project
}) {
  const projectId = project.id
  const gmailConnection = useGmailConnection(projectId, view === "email")

  if (view === "recommendations") {
    return <RecommendationsWorkspace project={toOutreachProject(project)} />
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
