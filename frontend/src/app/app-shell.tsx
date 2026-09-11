import * as React from "react"
import {
  Bell,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ListTodo,
  LoaderCircle,
  LogOut,
  Moon,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
} from "lucide-react"
import { Link, Navigate, Outlet, useLocation, useParams } from "react-router"

import { AgentDock, MobileAgentSheet } from "@/components/agent/agent-dock"
import { useTheme } from "@/components/theme-provider"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { BusinessProfileOnboardingController } from "@/features/projects/business-profile-onboarding"
import { useProjects } from "@/features/projects/project-context"
import { ProjectSwitcher } from "@/features/projects/project-switcher"

function getModulePath(projectId: string, moduleId: string) {
  const currentModule = modules.find((item) => item.id === moduleId)
  if (!currentModule || currentModule.tabs.length === 0) {
    return `/projects/${projectId}/${moduleId}`
  }
  return `/projects/${projectId}/${moduleId}/${currentModule.tabs[0].id}`
}

function AppSidebar() {
  const location = useLocation()
  const { getProject } = useProjects()
  const { isMobile, setOpenMobile, state, toggleSidebar } = useSidebar()
  const { projectId = "" } = useParams()
  const project = getProject(projectId)
  const currentProjectId = project.id || projectId
  const activeModule = location.pathname.split("/")[3] ?? "audit"

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
              <div className="flex h-12 items-center gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
                <span className="flex size-8 shrink-0 items-center justify-center font-serif text-2xl leading-none font-semibold text-violet-600 italic">
                  S
                </span>
              </div>
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
              className="hidden sm:inline-flex"
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
              className="relative hidden sm:inline-flex"
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
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs font-normal"
                onClick={() => setNotifications(0)}
              >
                全部已读
              </Button>
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
        className="hidden sm:inline-flex"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        aria-label="切换主题"
        title="切换主题"
      >
        {theme === "dark" ? <Sun /> : <Moon />}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-1 rounded-full"
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

function ProjectAppShell() {
  return (
    <TooltipProvider>
      <BusinessProfileOnboardingController />
      <SidebarProvider
        defaultOpen={false}
        style={{ "--sidebar-width": "180px" } as React.CSSProperties}
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
            <ProjectSwitcher />
            <div className="relative hidden max-w-md flex-1 md:block">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="border-0 bg-muted/60 pr-14 pl-9 focus-visible:ring-ring/40"
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

export function AppShell() {
  const { projectId = "" } = useParams()
  const { getProject, loadState } = useProjects()
  const project = getProject(projectId)

  if (loadState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 size-4 animate-spin" />
        正在加载项目
      </div>
    )
  }
  if (!projectId || !project.id) {
    return <Navigate to="/projects" replace />
  }
  return <ProjectAppShell />
}
