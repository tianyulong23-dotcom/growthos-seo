import * as React from "react"
import {
  Bell,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Command,
  Globe2,
  ListTodo,
  LogOut,
  Moon,
  Plus,
  Search,
  Settings,
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
import { modules, projects } from "@/data/mock-data"

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
  const { isMobile, setOpenMobile } = useSidebar()
  const { projectId = projects[0].id } = useParams()
  const project = projects.find((item) => item.id === projectId) ?? projects[0]
  const activeModule = location.pathname.split("/")[3] ?? "overview"

  function switchProject(nextProjectId: string) {
    const suffix = location.pathname
      .replace(`/projects/${projectId}`, "")
      .replace(/^\/+/, "")
    navigate(`/projects/${nextProjectId}/${suffix || "overview"}`)
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
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border p-2">
        <div className="flex h-10 items-center">
          <Link
            to={`/projects/${project.id}/overview`}
            onClick={closeMobileSidebar}
            className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden"
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Command className="size-4.5" />
            </div>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <div className="truncate text-sm font-semibold">SEO</div>
              <div className="truncate text-xs text-muted-foreground">
                SEO 工作台
              </div>
            </div>
          </Link>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button className="flex h-12 w-full items-center gap-2 rounded-md border bg-background px-2 text-left shadow-xs outline-none group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:p-0 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring" />
            }
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
              <Globe2 className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
              <span className="block truncate text-sm font-medium">
                {project.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {project.domain}
              </span>
            </span>
            <ChevronDown className="size-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-64"
            side="right"
            align="start"
            sideOffset={8}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>切换项目</DropdownMenuLabel>
              {projects.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  onClick={() => switchProject(item.id)}
                >
                  <Avatar className="size-7 rounded-md">
                    <AvatarFallback className="rounded-md text-xs">
                      {item.name.slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
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
            <DropdownMenuItem>
              <Plus />
              新建项目
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>工作区</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {modules.slice(0, -1).map((item) => {
                const Icon = item.icon
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      tooltip={item.label}
                      isActive={activeModule === item.id}
                      render={
                        <Link
                          to={getModulePath(project.id, item.id)}
                          onClick={closeMobileSidebar}
                        />
                      }
                    >
                      <Icon />
                      <span>{item.label}</span>
                      {item.id === "audit" && (
                        <Badge
                          variant="destructive"
                          className="ml-auto h-5 min-w-5 px-1.5 group-data-[collapsible=icon]:hidden"
                        >
                          29
                        </Badge>
                      )}
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
              tooltip="项目设置"
              isActive={activeModule === "settings"}
              render={
                <Link
                  to={getModulePath(project.id, "settings")}
                  onClick={closeMobileSidebar}
                />
              }
            >
              <Settings />
              <span>项目设置</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="帮助中心">
              <CircleHelp />
              <span>帮助中心</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
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
