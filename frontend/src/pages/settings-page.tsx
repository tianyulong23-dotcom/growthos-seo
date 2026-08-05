import { CircleAlert } from "lucide-react"

import { settingsNavigation } from "@/app/platform-navigation"
import { useCurrentProject } from "@/app/project-context"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { SettingsWorkspace } from "@/features/outreach/settings/settings-workspace"
import { ProjectProfileSettings } from "@/features/projects/project-workspace"
import { ModulePage } from "@/pages/module-page"

function EmptyServerState({ title }: { title: string }) {
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleAlert className="size-4 text-amber-600" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Badge variant="outline">INPUT_REQUIRED</Badge>
        <p className="mt-3 text-sm text-muted-foreground">
          当前公共 Gateway 未返回该配置，产品不会使用本地默认值代替。
        </p>
      </CardContent>
    </Card>
  )
}

function SettingsContent({
  view,
  websiteProjectKey,
}: {
  view: string
  websiteProjectKey: string
}) {
  if (view === "sources") {
    return <EmptyServerState title="数据连接状态未提供" />
  }

  if (view === "outreach") {
    return <SettingsWorkspace websiteProjectKey={websiteProjectKey} />
  }

  if (view === "notifications") {
    return <EmptyServerState title="通知规则未提供" />
  }

  return <ProjectProfileSettings />
}

export function SettingsPage() {
  const { currentProject } = useCurrentProject()
  const websiteProjectKey = currentProject?.id ?? ""

  return (
    <ModulePage module={settingsNavigation}>
      {(activeView) => (
        <SettingsContent
          view={activeView}
          websiteProjectKey={websiteProjectKey}
        />
      )}
    </ModulePage>
  )
}
