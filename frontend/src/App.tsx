import { useCallback, useEffect, useState } from "react"
import {
  BrowserRouter,
  Navigate,
  useRoutes,
  type RouteObject,
} from "react-router"

import { AppShell } from "@/app/app-shell"
import { registeredModuleRoutes } from "@/app/module-registry"
import {
  CurrentProjectProvider,
  useCurrentProject,
} from "@/app/project-context"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"
import { OverviewPage } from "@/pages/overview-page"
import { PerformancePage } from "@/pages/performance-page"
import { SettingsPage } from "@/pages/settings-page"
import { getRuntimeStatus } from "@/runtime-status"

function RuntimeAvailabilityBanner() {
  const [available, setAvailable] = useState<boolean | null>(null)

  const refresh = useCallback(async () => {
    try {
      const runtime = await getRuntimeStatus()
      setAvailable(runtime.business_consumers_running)
    } catch {
      setAvailable(false)
    }
  }, [])

  useEffect(() => {
    const initialCheck = window.setTimeout(() => void refresh(), 0)
    const poller = window.setInterval(() => void refresh(), 5_000)
    return () => {
      window.clearTimeout(initialCheck)
      window.clearInterval(poller)
    }
  }, [refresh])

  if (available !== false) return null
  return (
    <OutreachStandardStateView
      state="offline"
      compact
      title="后台任务处理已暂停"
      description="读取、草稿人工批准和发送前检查仍可用；新建项目、后台任务和实际发送暂不可用。"
      retryLabel="重新检查"
      onRetry={() => void refresh()}
    />
  )
}

function ProjectRedirect() {
  const { defaultProject, loading, error } = useCurrentProject()
  if (loading) {
    return (
      <OutreachStandardStateView
        state="loading"
        title="正在读取 Website Projects"
        description="正在从公开 Gateway 恢复授权项目列表。"
      />
    )
  }
  if (error || !defaultProject) {
    return (
      <OutreachStandardStateView
        state="error"
        title="Website Project 不可用"
        description="公开 Gateway 未返回可进入的 active Website Project。"
      />
    )
  }
  return <Navigate to={`/projects/${defaultProject.id}/overview`} replace />
}

function AuthorizedProjectShell() {
  const { currentProject, defaultProject, loading, error } = useCurrentProject()
  if (loading) {
    return (
      <OutreachStandardStateView
        state="loading"
        title="正在确认项目权限"
        description="正在校验 URL 中的 Website Project。"
      />
    )
  }
  if (error || !defaultProject) {
    return (
      <OutreachStandardStateView
        state="error"
        title="Website Project 不可用"
        description="无法从公开 Gateway 恢复授权项目。"
      />
    )
  }
  if (!currentProject) {
    return <Navigate to={`/projects/${defaultProject.id}/overview`} replace />
  }
  return <AppShell />
}

const routes: RouteObject[] = [
  {
    path: "/",
    element: <ProjectRedirect />,
  },
  {
    path: "/projects/:projectId",
    element: <AuthorizedProjectShell />,
    children: [
      { index: true, element: <Navigate to="overview" replace /> },
      { path: "overview", element: <OverviewPage /> },
      ...registeredModuleRoutes,
      { path: "performance", element: <PerformancePage /> },
      { path: "performance/:view", element: <PerformancePage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "settings/:view", element: <SettingsPage /> },
    ],
  },
  {
    path: "*",
    element: <ProjectRedirect />,
  },
]

function AppRoutes() {
  return useRoutes(routes)
}

export function App() {
  return (
    <BrowserRouter>
      <RuntimeAvailabilityBanner />
      <CurrentProjectProvider>
        <AppRoutes />
      </CurrentProjectProvider>
    </BrowserRouter>
  )
}

export default App
