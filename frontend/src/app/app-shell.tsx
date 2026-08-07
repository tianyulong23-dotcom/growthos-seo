import * as React from "react"
import {
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  ListTodo,
  LogOut,
  Moon,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
} from "lucide-react"
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router"

import { AgentDock, MobileAgentSheet } from "@/components/agent/agent-dock"
import { useTheme } from "@/components/theme-provider"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { modules } from "@/data/mock-data"
import { CreateProjectDialog } from "@/features/projects/create-project-dialog"
import { BusinessProfileOnboardingController } from "@/features/projects/business-profile-onboarding"
import { ProjectFavicon } from "@/features/projects/project-favicon"
import { useProjects } from "@/features/projects/project-context"

function getModulePath(projectId: string, moduleId: string) {
  const currentModule = modules.find((item) => item.id === moduleId)
  if (!currentModule || currentModule.tabs.length === 0) {
    return `/projects/${projectId}/${moduleId}`
  }
  return `/projects/${projectId}/${moduleId}/${currentModule.tabs[0].id}`
}

function AppSidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { projects, getProject } = useProjects()
  const [createOpen, setCreateOpen] = React.useState(false)
  const { isMobile, setOpenMobile, state, toggleSidebar } = useSidebar()
  const { projectId = projects[0]?.id ?? "" } = useParams()
  const project = getProject(projectId)
  const currentProjectId = project.id || projectId
  const activeModule = location.pathname.split("/")[3] ?? "audit"

  function switchProject(nextProjectId: string) {
    const suffix = location.pathname
      .replace(`/projects/${projectId}`, "")
      .replace(/^\/+/, "")
    navigate(`/projects/${nextProjectId}/${suffix || "audit/overview"}`)
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="h-16 min-h-16 shrink-0 justify-center border-b border-sidebar-border p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      size="lg"
                      tooltip={`SEO · ${project.domain}`}
                      className="h-12 transition-[width,padding] data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
                    />
                  }
                >
                  <ProjectFavicon project={project} />
                  <span className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                    <span className="truncate font-semibold">SEO</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {project.domain}
                    </span>
                  </span>
                  <ChevronDown className="ml-auto size-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-64"
                  side={isMobile ? "bottom" : "right"}
                  align="start"
                  sideOffset={4}
                >
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>切换项目</DropdownMenuLabel>
                    {projects.map((item) => (
                      <DropdownMenuItem
                        key={item.id}
                        onClick={() => switchProject(item.id)}
                      >
                        <ProjectFavicon project={item} className="size-7" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{item.name}</span>
                          <span className="block truncate text-xs font-normal text-muted-foreground">
                            {item.domain}
                          </span>
                        </span>
                        {item.id === project.id && (
                          <CheckCircle2 className="size-4 text-primary" />
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate("/projects")}>
                    <LayoutGrid />
                    所有项目
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                    <Plus />
                    新建项目
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <Button
          variant="outline"
          size="icon-sm"
          className="absolute top-12 -right-4 z-30 hidden bg-background shadow-xs group-data-[collapsible=icon]:top-[2.875rem] group-data-[collapsible=icon]:-right-3 group-data-[collapsible=icon]:size-6 xl:inline-flex"
          title={state === "collapsed" ? "展开导航" : "收起导航"}
          aria-label={state === "collapsed" ? "展开导航" : "收起导航"}
          onClick={toggleSidebar}
        >
          {state === "collapsed" ? <ChevronRight /> : <ChevronLeft />}
        </Button>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>工作区</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {modules
                  .filter(
                    (item) =>
                      item.id !== "settings" && item.id !== "platform-settings"
                  )
                  .map((item) => {
                    const Icon = item.icon
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          tooltip={item.label}
                          isActive={activeModule === item.id}
                          render={
                            <Link
                              to={getModulePath(currentProjectId, item.id)}
                              onClick={closeMobileSidebar}
                            />
                          }
                        >
                          <Icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="设置"
                isActive={activeModule === "settings"}
                render={
                  <Link
                    to={getModulePath(currentProjectId, "settings")}
                    onClick={closeMobileSidebar}
                  />
                }
              >
                <Settings />
                <span>设置</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="平台设置"
                isActive={activeModule === "platform-settings"}
                render={
                  <Link
                    to={getModulePath(currentProjectId, "platform-settings")}
                    onClick={closeMobileSidebar}
                  />
                }
              >
                <SlidersHorizontal />
                <span>平台设置</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  )
}

function HeaderActions() {
  const { theme, setTheme } = useTheme()
  const [tasks, setTasks] = React.useState([
    { id: 1, title: "全站技术审计", detail: "已完成 8,472 / 8,472 页" },
    { id: 2, title: "关键词排名更新", detail: "已完成 328 / 420 个" },
  ])
  const [notifications, setNotifications] = React.useState(3)

  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="任务中心"
              title="任务中心"
            />
          }
        >
          <ListTodo />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex items-center justify-between">
              任务中心
              <Badge variant="secondary">{tasks.length} 个任务</Badge>
            </DropdownMenuLabel>
            {tasks.map((task) => (
              <DropdownMenuItem key={task.id} className="items-start">
                <CheckCircle2 className="mt-0.5 text-emerald-600" />
                <span className="flex-1">
                  <span className="block">{task.title}</span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {task.detail}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setTasks([])}>
            清除已完成任务
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative"
              aria-label="通知"
              title="通知"
            />
          }
        >
          <Bell />
          {notifications > 0 && (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex items-center justify-between">
              通知
              <button
                className="text-xs font-normal text-primary"
                onClick={() => setNotifications(0)}
              >
                全部已读
              </button>
            </DropdownMenuLabel>
            <DropdownMenuItem className="items-start">
              <span className="mt-1 size-2 rounded-full bg-destructive" />
              <span>
                <span className="block">检测到 11 个新增 4xx 链接</span>
                <span className="text-xs font-normal text-muted-foreground">
                  12 分钟前
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="items-start">
              <span className="mt-1 size-2 rounded-full bg-primary" />
              <span>
                <span className="block">关键词排名数据已更新</span>
                <span className="text-xs font-normal text-muted-foreground">
                  1 小时前
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        aria-label="切换主题"
        title="切换主题"
      >
        {theme === "dark" ? <Sun /> : <Moon />}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              className="ml-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="账户菜单"
            />
          }
        >
          <Avatar className="size-8">
            <AvatarFallback className="bg-foreground text-xs text-background">
              林
            </AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              <span className="block">林木</span>
              <span className="block text-xs font-normal text-muted-foreground">
                admin@seo.local
              </span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <Settings />
            账户设置
          </DropdownMenuItem>
          <DropdownMenuItem>
            <LogOut />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function AppShell() {
  return (
    <TooltipProvider>
      <BusinessProfileOnboardingController />
      <SidebarProvider
        defaultOpen={false}
        style={{ "--sidebar-width": "14rem" } as React.CSSProperties}
      >
        <AppSidebar />
        <AgentDock />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
            <SidebarTrigger
              className="xl:hidden"
              aria-label="展开或收起导航"
              title="展开或收起导航"
            />
            <MobileAgentSheet />
            <div className="relative hidden max-w-md flex-1 md:block">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className="h-9 w-full rounded-md border-0 bg-muted/60 pr-14 pl-9 text-sm outline-none focus:ring-2 focus:ring-ring/40"
                placeholder="搜索当前项目..."
              />
              <kbd className="absolute top-1/2 right-2 -translate-y-1/2 rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                ⌘ K
              </kbd>
            </div>
            <div className="ml-auto">
              <HeaderActions />
            </div>
          </header>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
