import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
} from "react-router"

import { AppShell } from "@/app/app-shell"
import { RouteErrorPage } from "@/app/route-error-page"
import { ArticleEditorPage } from "@/features/content/article-editor-page"
import { DraftPage } from "@/features/outreach/drafts/draft-page"
import { ModulePage } from "@/pages/module-page"
import { ProjectsPage } from "@/pages/projects-page"

function ProjectRedirect() {
  return <Navigate to="/projects" replace />
}

export function App() {
  return <RouterProvider router={router} />
}

const router = createBrowserRouter([
  {
    element: <Outlet />,
    errorElement: <RouteErrorPage />,
    children: [
      { path: "/", element: <ProjectRedirect /> },
      { path: "/projects", element: <ProjectsPage /> },
      {
        path: "/projects/:projectId/content/articles/:articleId/edit",
        element: <ArticleEditorPage />,
      },
      {
        path: "/projects/:projectId",
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="audit/overview" replace /> },
          {
            path: "overview",
            element: <Navigate to="../audit/overview" replace />,
          },
          { path: "backlinks/drafts/:draftId", element: <DraftPage /> },
          { path: ":module", element: <ModulePage /> },
          { path: ":module/:view", element: <ModulePage /> },
        ],
      },
      { path: "*", element: <ProjectRedirect /> },
    ],
  },
])

export default App
