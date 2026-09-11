import { Link, useSearchParams } from "react-router"

import { useGmailConnection } from "@/features/outreach/gmail/use-gmail-connection"
import { linksApi } from "@/features/outreach/links/api"
import { LinksWorkspace } from "@/features/outreach/links/links-workspace"
import { MailSyncStatusPanel } from "@/features/outreach/mail/mail-sync-status-panel"
import { OpportunitiesWorkspace } from "@/features/outreach/opportunities/opportunities-workspace"
import { toOutreachProject } from "@/features/outreach/project"
import { RecommendationFeedWorkspace } from "@/features/outreach/recommendations/recommendation-feed-workspace"
import { RecommendationProjectGate } from "@/features/outreach/recommendations/promotion-target-setup"
import { BacklinkReportsRouteWorkspace } from "@/features/performance/backlinks/backlink-reports-route-workspace"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"
import type { Project } from "@/features/projects/types"

function BusinessContextBar({
  websiteProjectKey,
}: {
  websiteProjectKey: string
}) {
  const [searchParams] = useSearchParams()
  const context = [
    ["Opportunity", searchParams.get("opportunityId")],
    ["Reply", searchParams.get("replyId")],
    ["Placement", searchParams.get("placementId")],
  ].filter((item): item is [string, string] => Boolean(item[1]?.trim()))
  const returnTo = searchParams.get("returnTo")
  const performanceReturnTo = `/projects/${websiteProjectKey}/performance/backlinks`
  const safeReturnTo =
    returnTo?.startsWith(`/projects/${websiteProjectKey}/backlinks/`) ===
      true ||
    returnTo === performanceReturnTo ||
    returnTo?.startsWith(`${performanceReturnTo}?`) === true
      ? returnTo
      : null

  if (context.length === 0 && safeReturnTo === null) return null

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-y bg-muted/20 px-3 py-2 text-xs">
      {context.map(([label, value]) => (
        <span className="break-all" key={label}>
          <span className="text-muted-foreground">{label}：</span>
          {value}
        </span>
      ))}
      {safeReturnTo ? (
        <Link
          className="ml-auto text-primary hover:underline"
          to={safeReturnTo}
        >
          返回来源
        </Link>
      ) : null}
    </div>
  )
}

export function OutreachWorkspace({
  view,
  project,
}: {
  view: string
  project: Project
}) {
  const projectId = project.id
  const gmailConnection = useGmailConnection(projectId, view === "email")
  let content

  if (view === "recommendations") {
    content = (
      <RecommendationProjectGate
        key={`${project.id}:${project.contextVersion}`}
        project={toOutreachProject(project)}
      >
        {(readyProject) => (
          <RecommendationFeedWorkspace project={readyProject} />
        )}
      </RecommendationProjectGate>
    )
  } else if (view === "opportunities") {
    content = <OpportunitiesWorkspace websiteProjectKey={projectId} />
  } else if (view === "links") {
    content = <LinksWorkspace client={linksApi} websiteProjectKey={projectId} />
  } else if (view === "reports") {
    content = <BacklinkReportsRouteWorkspace websiteProjectKey={projectId} />
  } else if (view === "email") {
    content = <MailSyncStatusPanel controller={gmailConnection} />
  } else {
    content = (
      <OutreachStandardStateView
        state="error"
        title="页面不可用"
        description="当前 Outreach 路由未注册。"
      />
    )
  }

  return (
    <>
      <BusinessContextBar websiteProjectKey={projectId} />
      {content}
    </>
  )
}
