import * as React from "react"
import {
  Download,
  FilePlus2,
  Link2,
  LoaderCircle,
  Plus,
} from "lucide-react"
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router"

import type { NavigationItem } from "@/app/module-contract"
import { PageHeader } from "@/components/shared/page-header"
import { createAuditRun, getAuditRun, type AuditRun } from "@/api/audits"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArticleWorkspace } from "@/features/content/article-workspace"
import { ContentLibrary } from "@/features/content/content-library"
import { ContentPlan } from "@/features/content/content-plan"
import { CreateArticleDialog } from "@/features/content/create-article-dialog"
import { BusinessProfileForm } from "@/features/projects/business-profile-form"
import { AIModelSettings } from "@/features/settings/ai-model-settings"
import { modules } from "@/data/mock-data"
import type { AuditSettings } from "@/features/audit/audit-settings"
import {
  getCachedCompletedAuditRun,
  rememberAuditRun,
} from "@/features/audit/audit-session-cache"
import { useAuditRunPolling } from "@/features/audit/use-audit-run-polling"
import { useProjects } from "@/features/projects/project-context"
import type { BusinessProfileInput, Project } from "@/features/projects/types"

const AuditWorkspace = React.lazy(() =>
  import("@/features/audit/audit-workspace").then((module) => ({
    default: module.AuditWorkspace,
  }))
)

const KeywordWorkspace = React.lazy(() =>
  import("@/features/keywords/keyword-workspace").then((module) => ({
    default: module.KeywordWorkspace,
  }))
)

const OutreachWorkspace = React.lazy(() =>
  import("@/features/outreach/outreach-workspace").then((module) => ({
    default: module.OutreachWorkspace,
  }))
)

function ContentContent({
  view,
  projectId,
  articleId,
  addRequestVersion,
  onOpenArticle,
  onCloseArticle,
}: {
  view: string
  projectId: string
  articleId: string | null
  addRequestVersion: number
  onOpenArticle: (articleId: string) => void
  onCloseArticle: () => void
}) {
  if (!projectId) {
    return (
      <div className="space-y-3" aria-label="正在读取项目">
        <Skeleton className="h-16 rounded-md" />
        <Skeleton className="h-64 rounded-md" />
      </div>
    )
  }

  if (articleId) {
    return (
      <ArticleWorkspace
        key={`${projectId}:${articleId}`}
        projectId={projectId}
        articleId={articleId}
        onBack={onCloseArticle}
      />
    )
  }

  if (view === "plans") {
    return (
      <ContentPlan
        key={projectId}
        addRequestVersion={addRequestVersion}
        onOpenArticle={onOpenArticle}
      />
    )
  }

  return <ContentLibrary projectId={projectId} onOpenArticle={onOpenArticle} />
}

function PerformanceContent({ view }: { view: string }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {[
          [view === "search" ? "自然点击" : "内容点击", "12,648", "+18.4%"],
          ["转化", "486", "+9.2%"],
          ["转化率", "3.84%", "+0.3%"],
          ["预估价值", "¥86,420", "+14.8%"],
        ].map(([label, value, change]) => (
          <div key={label} className="bg-card p-4">
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-semibold">{value}</div>
            <div className="mt-1 text-xs text-emerald-600">{change}</div>
          </div>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{view === "search" ? "渠道表现" : "内容贡献"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {[
            ["Google 自然搜索", 68, "8,598"],
            ["Bing 自然搜索", 21, "2,656"],
            ["AI 搜索引用", 7, "885"],
            ["其他搜索引擎", 4, "509"],
          ].map(([label, value, clicks]) => (
            <div
              key={label}
              className="grid gap-2 sm:grid-cols-[180px_1fr_70px] sm:items-center"
            >
              <span className="text-sm">{label}</span>
              <Progress value={Number(value)} />
              <span className="text-right text-sm text-muted-foreground tabular-nums">
                {clicks}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function SettingsContent({
  view,
  project,
  onSaveBusinessProfile,
  onRefreshBusinessProfile,
}: {
  view: string
  project: Project
  onSaveBusinessProfile: (input: BusinessProfileInput) => Promise<unknown>
  onRefreshBusinessProfile: () => Promise<unknown>
}) {
  const understandingInProgress =
    project.understandingStatus === "queued" ||
    project.understandingStatus === "running"
  const waitingForProfile = !project.siteProfile && understandingInProgress

  if (view === "ai") {
    return <AIModelSettings projectId={project.id} />
  }

  if (view === "notifications") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>通知规则</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {[
            ["审计完成", "每次网站审计完成后通知", true],
            ["严重问题", "发现新的高优先级技术问题时通知", true],
            ["排名波动", "关键词排名单日变化超过 5 位时通知", true],
            ["内容到期", "内容进入计划更新日期时通知", false],
          ].map(([title, description, enabled]) => (
            <label
              key={String(title)}
              className="flex items-center gap-4 py-4 first:pt-0 last:pb-0"
            >
              <span className="flex-1">
                <span className="block text-sm font-medium">{title}</span>
                <span className="block text-xs text-muted-foreground">
                  {description}
                </span>
              </span>
              <Switch defaultChecked={Boolean(enabled)} />
            </label>
          ))}
        </CardContent>
      </Card>
    )
  }

  if (project.siteProfile) {
    return (
      <BusinessProfileForm
        project={project}
        onSave={onSaveBusinessProfile}
        onRefresh={onRefreshBusinessProfile}
        refreshing={understandingInProgress}
      />
    )
  }

  if (waitingForProfile) {
    return (
      <div className="max-w-2xl py-10">
        <div className="flex items-start gap-3">
          <LoaderCircle className="mt-0.5 size-5 animate-spin text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="font-medium">正在识别网站业务</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              完成后可在这里确认企业、客户和产品服务信息。
            </p>
            <Progress
              value={project.understandingProgress}
              className="mt-4 h-1.5"
            />
          </div>
        </div>
      </div>
    )
  }

  if (project.understandingStatus === "failed") {
    return (
      <div className="max-w-2xl py-10">
        <h2 className="font-medium">暂时无法生成业务资料</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {project.understandingMessage ||
            "网站业务识别未完成，当前没有可确认的业务资料。"}
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl py-10">
      <h2 className="font-medium">还没有业务资料</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        网站业务识别完成后，业务资料会显示在这里。
      </p>
    </div>
  )
}

function ModuleBody({
  moduleId,
  view,
  project,
  onStart,
  auditRun,
  auditError,
  onAuditRunChange,
  onProjectRefresh,
  onSaveBusinessProfile,
  onRefreshBusinessProfile,
  articleId,
  contentPlanAddRequestVersion,
  onOpenArticle,
  onCloseArticle,
}: {
  moduleId: string
  view: string
  project: Project
  onStart: (settings: AuditSettings) => Promise<void>
  auditRun: AuditRun | null
  auditError: string
  onAuditRunChange: (run: AuditRun | null) => void
  onProjectRefresh: () => Promise<unknown>
  onSaveBusinessProfile: (input: BusinessProfileInput) => Promise<unknown>
  onRefreshBusinessProfile: () => Promise<unknown>
  articleId: string | null
  contentPlanAddRequestVersion: number
  onOpenArticle: (articleId: string) => void
  onCloseArticle: () => void
}) {
  if (moduleId === "audit")
    return (
      <React.Suspense
        fallback={
          <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            正在加载网站审计
          </div>
        }
      >
        <AuditWorkspace
          key={project.id}
          view={view}
          project={project}
          onStart={onStart}
          run={auditRun}
          error={auditError}
          onRunChange={onAuditRunChange}
          onProjectRefresh={onProjectRefresh}
        />
      </React.Suspense>
    )
  if (moduleId === "keywords")
    return (
      <React.Suspense
        fallback={
          <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            正在加载关键词库
          </div>
        }
      >
        <KeywordWorkspace key={project.id} projectId={project.id} />
      </React.Suspense>
    )
  if (moduleId === "content")
    return (
      <ContentContent
        view={view}
        projectId={project.id}
        articleId={articleId}
        addRequestVersion={contentPlanAddRequestVersion}
        onOpenArticle={onOpenArticle}
        onCloseArticle={onCloseArticle}
      />
    )
  if (moduleId === "backlinks")
    return (
      <React.Suspense
        fallback={
          <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            正在加载外链模块
          </div>
        }
      >
        <OutreachWorkspace view={view} />
      </React.Suspense>
    )
  if (moduleId === "performance") return <PerformanceContent view={view} />
  if (moduleId === "settings")
    return (
      <SettingsContent
        key={project.id}
        view={view}
        project={project}
        onSaveBusinessProfile={onSaveBusinessProfile}
        onRefreshBusinessProfile={onRefreshBusinessProfile}
      />
    )
  return null
}

type RegisteredModulePageProps = {
  module: NavigationItem
  children: (activeView: string) => React.ReactNode
  actionLabel?: string
  actionIcon?: React.ReactNode
  onAction?: () => void
  actionDisabled?: boolean
  beforeContent?: React.ReactNode
}

function RegisteredModulePage({
  module,
  children,
  actionLabel,
  actionIcon,
  onAction,
  actionDisabled,
  beforeContent,
}: RegisteredModulePageProps) {
  const navigate = useNavigate()
  const { projects } = useProjects()
  const { projectId = projects[0]?.id ?? "", view } = useParams<{
    projectId: string
    view?: string
  }>()
  const activeView = view ?? module.tabs[0]?.id

  if (!activeView) {
    return <Navigate to={`/projects/${projectId}/overview`} replace />
  }
  if (!module.tabs.some((tab) => tab.id === activeView)) {
    return (
      <Navigate
        to={`/projects/${projectId}/${module.id}/${module.tabs[0].id}`}
        replace
      />
    )
  }

  return (
    <div className="min-w-0">
      <PageHeader
        module={module}
        actionLabel={actionLabel}
        actionIcon={actionIcon}
        onAction={onAction}
        actionDisabled={actionDisabled}
      />
      <div className="border-b px-4 sm:px-6 lg:px-8">
        <Tabs
          value={activeView}
          onValueChange={(nextView) =>
            navigate(`/projects/${projectId}/${module.id}/${nextView}`)
          }
        >
          <TabsList
            variant="line"
            className="no-scrollbar h-11 max-w-full justify-start overflow-x-auto"
          >
            {module.tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="min-w-0 p-4 sm:p-6 lg:p-8">
        {beforeContent}
        {children(activeView)}
      </div>
    </div>
  )
}

type ModulePageProps = Partial<RegisteredModulePageProps>

export function ModulePage(props: ModulePageProps) {
  if (props.module && props.children) {
    return (
      <RegisteredModulePage
        {...props}
        module={props.module}
        children={props.children}
      />
    )
  }
  return <LegacyModulePage />
}

function LegacyModulePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const {
    projects,
    getProject,
    refreshProject,
    updateBusinessProfile,
    refreshBusinessProfile,
  } = useProjects()
  const { projectId = projects[0]?.id ?? "", module = "", view } = useParams()
  const project = getProject(projectId)
  const currentModule = modules.find((item) => item.id === module)
  const requestedAuditRunId =
    module === "audit" ? searchParams.get("runId") : null
  const targetAuditRunId = requestedAuditRunId || project.auditRunId
  const [auditState, setAuditState] = React.useState<{
    projectId: string
    targetRunId: string | null
    run: AuditRun | null
    error: string
  }>(() => {
    const cachedRun = targetAuditRunId
      ? getCachedCompletedAuditRun(project.id, targetAuditRunId)
      : null
    return {
      projectId: project.id,
      targetRunId: cachedRun?.run_id ?? null,
      run: cachedRun,
      error: "",
    }
  })
  const [actionCount, setActionCount] = React.useState(0)
  const [createArticleOpen, setCreateArticleOpen] = React.useState(false)
  const [contentPlanAddRequestVersion, setContentPlanAddRequestVersion] =
    React.useState(0)
  const auditSelectionVersion = React.useRef(0)
  const activeProjectId = React.useRef(project.id)
  React.useLayoutEffect(() => {
    activeProjectId.current = project.id
    return () => {
      activeProjectId.current = ""
    }
  }, [project.id])
  const cachedTargetAuditRun = targetAuditRunId
    ? getCachedCompletedAuditRun(project.id, targetAuditRunId)
    : null
  const currentAuditRun =
    auditState.projectId === project.id &&
    auditState.targetRunId === targetAuditRunId &&
    auditState.run?.project_id === project.id
      ? auditState.run
      : cachedTargetAuditRun
  const currentAuditError =
    auditState.projectId === project.id &&
    auditState.targetRunId === targetAuditRunId
      ? auditState.error
      : ""
  const running =
    currentAuditRun?.status === "queued" ||
    currentAuditRun?.status === "running" ||
    currentAuditRun?.status === "stopping" ||
    currentAuditRun?.status === "recalculating"

  const handleAuditRunChange = React.useCallback(
    (run: AuditRun | null, sourceProjectId: string) => {
      if (
        sourceProjectId !== activeProjectId.current ||
        (run && run.project_id !== sourceProjectId)
      ) {
        return
      }
      if (run) rememberAuditRun(run)
      auditSelectionVersion.current += 1
      setAuditState({
        projectId: sourceProjectId,
        targetRunId: run?.run_id ?? null,
        run,
        error: "",
      })
    },
    [setAuditState]
  )

  const handleAuditError = React.useCallback(
    (
      message: string,
      sourceProjectId: string,
      sourceRunId: string | null = targetAuditRunId
    ) => {
      if (sourceProjectId !== activeProjectId.current) {
        return
      }
      setAuditState((current) => ({
        projectId: sourceProjectId,
        targetRunId: sourceRunId,
        run: current.projectId === sourceProjectId ? current.run : null,
        error: message,
      }))
    },
    [setAuditState, targetAuditRunId]
  )

  React.useEffect(() => {
    if (!project.id || !targetAuditRunId) return
    const cachedRun = getCachedCompletedAuditRun(project.id, targetAuditRunId)
    if (cachedRun) return
    const selectionVersion = auditSelectionVersion.current
    let active = true
    void getAuditRun(project.id, targetAuditRunId)
      .then((run) => {
        if (
          active &&
          selectionVersion === auditSelectionVersion.current &&
          run.project_id === activeProjectId.current &&
          run.run_id === targetAuditRunId
        ) {
          rememberAuditRun(run)
          setAuditState({
            projectId: run.project_id,
            targetRunId: run.run_id,
            run,
            error: "",
          })
        }
      })
      .catch((error: unknown) => {
        if (
          active &&
          selectionVersion === auditSelectionVersion.current &&
          project.id === activeProjectId.current
        ) {
          setAuditState({
            projectId: project.id,
            targetRunId: targetAuditRunId,
            run: null,
            error: error instanceof Error ? error.message : "读取审计状态失败",
          })
        }
      })
    return () => {
      active = false
    }
  }, [project.id, targetAuditRunId])

  useAuditRunPolling({
    run: currentAuditRun,
    onRunChange: (run) => handleAuditRunChange(run, run.project_id),
    onError: (message) =>
      handleAuditError(message, project.id, currentAuditRun?.run_id ?? null),
    onTerminal: refreshProject,
  })

  if (!currentModule || currentModule.id === "overview") {
    return <Navigate to={`/projects/${projectId}/overview`} replace />
  }

  const moduleConfig = currentModule
  const activeView = view ?? moduleConfig.tabs[0]?.id
  if (!activeView) {
    return <Navigate to={`/projects/${projectId}/overview`} replace />
  }
  if (!moduleConfig.tabs.some((tab) => tab.id === activeView)) {
    return (
      <Navigate
        to={`/projects/${projectId}/${moduleConfig.id}/${moduleConfig.tabs[0].id}`}
        replace
      />
    )
  }

  async function handleAuditStart(settings: AuditSettings) {
    handleAuditError("", project.id)
    const run = await createAuditRun(project, settings)
    handleAuditRunChange(run, project.id)
    navigate(
      `/projects/${project.id}/audit/overview?runId=${encodeURIComponent(
        run.run_id
      )}`,
      { replace: true }
    )
    try {
      await refreshProject(project.id)
    } catch (error) {
      if (project.id === activeProjectId.current) {
        handleAuditError(
          `审计已启动，但项目状态刷新失败：${
            error instanceof Error ? error.message : "未知错误"
          }`,
          project.id,
          run.run_id
        )
      }
    }
  }

  function handleAction() {
    if (moduleConfig.id === "content") {
      if (activeView === "plans") {
        setContentPlanAddRequestVersion((version) => version + 1)
        return
      }
      setCreateArticleOpen(true)
      return
    }
    setActionCount((count) => count + 1)
  }

  const selectedArticleId =
    moduleConfig.id === "content" ? searchParams.get("articleId") : null

  function openArticle(articleId: string) {
    navigate(
      `/projects/${project.id}/content/library?articleId=${encodeURIComponent(articleId)}`
    )
  }

  function closeArticle() {
    navigate(`/projects/${project.id}/content/library`)
  }

  const actionIcon =
    moduleConfig.id === "content" ? (
      activeView === "plans" ? (
        <Plus />
      ) : (
        <FilePlus2 />
      )
    ) : moduleConfig.id === "backlinks" ? (
      <Link2 />
    ) : moduleConfig.id === "performance" ? (
      <Download />
    ) : (
      <Plus />
    )

  return (
    <div className="min-w-0">
      <PageHeader
        module={moduleConfig}
        actionLabel={
          moduleConfig.id === "audit" ||
          moduleConfig.id === "settings" ||
          moduleConfig.id === "keywords"
            ? undefined
            : moduleConfig.id === "content" && activeView === "library"
              ? "创建文章"
              : moduleConfig.id !== "content" && actionCount > 0
                ? `已添加 ${actionCount} 项`
                : moduleConfig.action
        }
        actionIcon={actionIcon}
        onAction={handleAction}
        actionDisabled={moduleConfig.id === "audit" && running}
      />
      {moduleConfig.tabs.length > 0 && (
        <div className="border-b px-4 sm:px-6 lg:px-8">
          <Tabs
            value={activeView}
            onValueChange={(nextView) => {
              const query =
                moduleConfig.id === "audit" && requestedAuditRunId
                  ? `?runId=${encodeURIComponent(requestedAuditRunId)}`
                  : ""
              navigate(
                `/projects/${projectId}/${moduleConfig.id}/${nextView}${query}`
              )
            }}
          >
            <TabsList
              variant="line"
              className="no-scrollbar h-11 max-w-full justify-start overflow-x-auto"
            >
              {moduleConfig.tabs.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}
      <div className="p-4 sm:p-6 lg:p-8">
        <ModuleBody
          moduleId={moduleConfig.id}
          view={activeView}
          project={project}
          onStart={handleAuditStart}
          auditRun={currentAuditRun}
          auditError={currentAuditError}
          onAuditRunChange={(run) => {
            handleAuditRunChange(run, project.id)
            if (run && run.run_id !== targetAuditRunId) {
              navigate(
                `/projects/${project.id}/audit/${activeView}?runId=${encodeURIComponent(
                  run.run_id
                )}`
              )
            }
          }}
          onProjectRefresh={() => refreshProject(project.id)}
          onSaveBusinessProfile={(input) =>
            updateBusinessProfile(project.id, input)
          }
          onRefreshBusinessProfile={() => refreshBusinessProfile(project.id)}
          articleId={selectedArticleId}
          contentPlanAddRequestVersion={contentPlanAddRequestVersion}
          onOpenArticle={openArticle}
          onCloseArticle={closeArticle}
        />
      </div>
      {moduleConfig.id === "content" && activeView === "library" && (
        <CreateArticleDialog
          projectId={project.id}
          open={createArticleOpen}
          onOpenChange={setCreateArticleOpen}
          onCreated={(article) => openArticle(article.id)}
        />
      )}
    </div>
  )
}
