import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router"
import { describe, expect, it, vi } from "vitest"

import { ProjectSwitcher } from "@/features/projects/project-switcher"

vi.mock("@/features/projects/project-context", () => ({
  useProjects: () => {
    const projects = [
      {
        id: "project-1",
        name: "Project One",
        domain: "one.example",
      },
      {
        id: "project-2",
        name: "Project Two",
        domain: "two.example",
      },
    ]
    return {
      projects,
      getProject: (projectId: string) =>
        projects.find((project) => project.id === projectId) ?? projects[0],
    }
  },
}))

describe("ProjectSwitcher", () => {
  it("opens the project menu without violating the menu group contract", () => {
    render(
      <MemoryRouter initialEntries={["/projects/project-1/backlinks/email"]}>
        <Routes>
          <Route
            path="/projects/:projectId/backlinks/email"
            element={<ProjectSwitcher />}
          />
        </Routes>
      </MemoryRouter>
    )

    fireEvent.click(
      screen.getByRole("button", {
        name: "切换项目，当前为 Project One",
      })
    )

    expect(screen.getByText("当前项目")).toBeTruthy()
    expect(screen.getByText("Project Two")).toBeTruthy()
  })
})
