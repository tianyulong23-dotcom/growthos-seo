export type Project = {
  id: string
  name: string
  domain: string
  health: number
}

export const projects: readonly Project[] = [
  {
    id: "elephtv",
    name: "ElephTV",
    domain: "elephtv.com",
    health: 84,
  },
  {
    id: "solarreviews",
    name: "Solar Reviews",
    domain: "solarreviews.com",
    health: 86,
  },
  {
    id: "growthlab",
    name: "Growth Lab",
    domain: "growthlab.io",
    health: 73,
  },
  {
    id: "northstar",
    name: "Northstar 中文站",
    domain: "cn.northstar.com",
    health: 91,
  },
]

export const defaultProject = projects[0]

export function getProject(projectId?: string) {
  return projects.find((project) => project.id === projectId) ?? defaultProject
}
