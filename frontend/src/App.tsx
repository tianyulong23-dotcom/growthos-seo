import { BrowserRouter, Navigate, Route, Routes } from "react-router"

import { AppShell } from "@/app/app-shell"
import { DraftPage } from "@/features/outreach/drafts/draft-page"
import { ModulePage } from "@/pages/module-page"
import { ProjectsPage } from "@/pages/projects-page"

function ProjectRedirect() {
  return <Navigate to="/projects" replace />
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProjectRedirect />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<AppShell />}>
          <Route index element={<Navigate to="audit/overview" replace />} />
          <Route
            path="overview"
            element={<Navigate to="../audit/overview" replace />}
          />
          <Route path="backlinks/drafts/:draftId" element={<DraftPage />} />
          <Route path=":module" element={<ModulePage />} />
          <Route path=":module/:view" element={<ModulePage />} />
        </Route>
        <Route path="*" element={<ProjectRedirect />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
