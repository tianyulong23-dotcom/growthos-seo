import { Check, ChevronDown, LayoutGrid } from "lucide-react"
import { useLocation, useNavigate, useParams } from "react-router"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ProjectFavicon } from "@/features/projects/project-favicon"
import { useProjects } from "@/features/projects/project-context"
import { projectRouteForSwitch } from "@/features/projects/project-route"

export function ProjectSwitcher() {
  const location = useLocation()
  const navigate = useNavigate()
  const { projectId = "" } = useParams()
  const { projects, getProject } = useProjects()
  const project = getProject(projectId)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 max-w-56 min-w-0 justify-start px-2"
            aria-label={`切换项目，当前为 ${project.name}`}
          />
        }
      >
        <ProjectFavicon project={project} className="size-6" />
        <span className="min-w-0 truncate font-medium">{project.name}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72" align="start">
        <DropdownMenuGroup>
          <DropdownMenuLabel>当前项目</DropdownMenuLabel>
          {projects.map((item) => (
            <DropdownMenuItem
              key={item.id}
              disabled={item.id === project.id}
              onClick={() =>
                navigate(
                  projectRouteForSwitch(location.pathname, project.id, item.id)
                )
              }
            >
              <ProjectFavicon project={item} className="size-7" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.name}</span>
                <span className="block truncate text-xs font-normal text-muted-foreground">
                  {item.domain}
                </span>
              </span>
              {item.id === project.id && (
                <Check className="size-4 text-primary" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/projects")}>
          <LayoutGrid />
          所有项目
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
