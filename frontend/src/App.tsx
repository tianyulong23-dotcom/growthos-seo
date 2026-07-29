import {
  BrowserRouter,
  Navigate,
  useRoutes,
  type RouteObject,
} from "react-router"

import { AppShell } from "@/app/app-shell"
import { registeredModuleRoutes } from "@/app/module-registry"
import { defaultProject } from "@/app/project-context"
import { OverviewPage } from "@/pages/overview-page"
import { PerformancePage } from "@/pages/performance-page"
import { SettingsPage } from "@/pages/settings-page"

function ProjectRedirect() {
  return <Navigate to={`/projects/${defaultProject.id}/overview`} replace />
}

const routes: RouteObject[] = [
  {
    path: "/",
    element: <ProjectRedirect />,
  },
  {
    path: "/projects/:projectId",
    element: <AppShell />,
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
      <AppRoutes />
    </BrowserRouter>
  )
}

export default App
