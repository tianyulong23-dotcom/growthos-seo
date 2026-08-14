import * as React from "react"
import { FilePlus2, Link2, LoaderCircle, Plus } from "lucide-react"
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router"

import type { NavigationItem } from "@/app/module-contract"
import { PageHeader } from "@/components/shared/page-header"
import {
  createAuditRun,
  getAuditRun,
  listAuditRuns,
  type AuditRun,
} from "@/api/audits"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ArticleWorkspace } from "@/features/content/article-workspace"
import { ContentLibrary } from "@/features/content/content-library"
import { ContentPlan } from "@/features/content/content-plan"
import { CreateArticleDialog } from "@/features/content/create-article-dialog"
import { BusinessProfileForm } from "@/features/projects/business-profile-form"
import { AIModelSettings } from "@/features/settings/ai-model-settings"
import { DataForSEOSettings } from "@/features/settings/data-source-settings"
import { GSCOAuthSettings } from "@/features/settings/gsc-oauth-settings"
import { ServiceConnectionsSettings } from "@/features/settings/service-connections-settings"
import { modules } from "@/data/mock-data"
import type { AuditSettings } from "@/features/audit/audit-settings"
import {
  getCachedCompletedAuditRun,
  rememberAuditRun,
} from "@/features/audit/audit-session-cache"
import { useAuditRunPolling } from "@/features/audit/use-audit-run-polling"
import { PerformanceWorkspace } from "@/features/performance/performance-workspace"
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

function prefetchKeywordTab(projectId: string, view: string) {
  void import("@/features/keywords/keyword-query-client")
    .then(({ prefetchKeywordView }) => prefetchKeywordView(projectId, view))
    .catch(() => undefined)
}

function ContentContent({
  view,
  projectId,
  articleId,
  onOpenArticle,
  onCloseArticle,
}: {
  view: string
  projectId: string
  articleId: string | null
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
        projectId={projectId}
        onOpenArticle={onOpenArticle}
      />
    )
  }

  return <ContentLibrary projectId={projectId} onOpenArticle={onOpenArticle} />
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

  if (view === "connections") {
    return (
      <ServiceConnectionsSettings
        projectId={project.id}
        projectDomain={project.domain}
      />
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

function PlatformSettingsContent({
  view,
  projectId,
}: {
  view: string
  projectId: string
}) {
  if (view === "dataforseo") {
    return <DataForSEOSettings projectId={projectId} />
  }

  if (view === "google-oauth") {
    return <GSCOAuthSettings projectId={projectId} />
  }

  return <AIModelSettings projectId={projectId} />
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
        <KeywordWorkspace
          key={project.id}
          projectId={project.id}
          view={view}
          savedCompetitorDomain={project.competitorDomain}
        />
      </React.Suspense>
    )
  if (moduleId === "content")
    return (
      <ContentContent
        view={view}
        projectId={project.id}
        articleId={articleId}
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
  if (moduleId === "performance")
    return (
      <PerformanceWorkspace
        key={project.id}
        view={view}
        projectId={project.id}
        onOpenArticle={onOpenArticle}
      />
    )
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
  if (moduleId === "platform-settings")
    return <PlatformSettingsContent view={view} projectId={project.id} />
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
    return <Navigate to={`/projects/${projectId}/audit/overview`} replace />
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
  const [auditAvailability, setAuditAvailability] = React.useState({
    requestKey: "",
    loaded: false,
    totalRuns: project.auditStatus === "never_started" ? 0 : 1,
    completedRuns: project.auditStatus === "completed" ? 1 : 0,
  })
  const [actionCount, setActionCount] = React.useState(0)
  const [createArticleOpen, setCreateArticleOpen] = React.useState(false)
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
  const currentRunIsHistorical =
    currentAuditRun?.status === "completed" ||
    currentAuditRun?.status === "failed" ||
    currentAuditRun?.status === "stopped"
  const projectRunIsHistorical =
    project.auditStatus === "completed" ||
    project.auditStatus === "failed" ||
    project.auditStatus === "stopped"
  const currentOrProjectRunIsActive = [
    "queued",
    "running",
    "paused",
    "stopping",
    "recalculating",
  ].includes(currentAuditRun?.status ?? project.auditStatus)
  const auditAvailabilityRequestKey = [
    project.id,
    project.auditRunId ?? "",
    project.auditStatus,
  ].join("\x1f")
  const currentAuditAvailability =
    auditAvailability.requestKey === auditAvailabilityRequestKey
  const projectHasCompletedAudit =
    currentAuditRun?.status === "completed" ||
    project.auditStatus === "completed" ||
    (currentAuditAvailability && auditAvailability.completedRuns > 0)
  const projectHasAuditHistory =
    currentRunIsHistorical ||
    projectRunIsHistorical ||
    (currentAuditAvailability &&
      auditAvailability.loaded &&
      auditAvailability.totalRuns > (currentOrProjectRunIsActive ? 1 : 0))

  React.useEffect(() => {
    if (module !== "audit" || !project.id) return
    let active = true
    void Promise.all([
      listAuditRuns(project.id, {
        includeArchived: true,
        page: 1,
        pageSize: 1,
      }),
      listAuditRuns(project.id, {
        includeArchived: true,
        page: 1,
        pageSize: 1,
        status: "completed",
      }),
    ])
      .then(([allRuns, completedRuns]) => {
        if (!active || project.id !== activeProjectId.current) return
        setAuditAvailability({
          requestKey: auditAvailabilityRequestKey,
          loaded: true,
          totalRuns: allRuns.total,
          completedRuns: completedRuns.total,
        })
      })
      .catch(() => {
        if (!active || project.id !== activeProjectId.current) return
        setAuditAvailability({
          requestKey: auditAvailabilityRequestKey,
          loaded: true,
          totalRuns: project.auditStatus === "never_started" ? 0 : 1,
          completedRuns: project.auditStatus === "completed" ? 1 : 0,
        })
      })
    return () => {
      active = false
    }
  }, [auditAvailabilityRequestKey, module, project.auditStatus, project.id])

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

  if (!currentModule) {
    return <Navigate to={`/projects/${projectId}/audit/overview`} replace />
  }

  const moduleConfig = currentModule
  const activeView = view ?? moduleConfig.tabs[0]?.id
  if (!activeView) {
    return <Navigate to={`/projects/${projectId}/audit/overview`} replace />
  }
  if (moduleConfig.id === "settings") {
    const legacySettingsViews: Record<string, string> = {
      profile: "business",
      sources: "connections",
      outreach: "business",
      notifications: "business",
    }
    const replacement = legacySettingsViews[activeView]
    if (replacement) {
      return (
        <Navigate
          to={`/projects/${projectId}/settings/${replacement}`}
          replace
        />
      )
    }
    const legacyPlatformViews: Record<string, string> = {
      ai: "ai",
      "platform-ai": "ai",
      dataforseo: "dataforseo",
      "platform-dataforseo": "dataforseo",
    }
    const platformReplacement = legacyPlatformViews[activeView]
    if (platformReplacement) {
      return (
        <Navigate
          to={`/projects/${projectId}/platform-settings/${platformReplacement}`}
          replace
        />
      )
    }
  }
  if (moduleConfig.id === "platform-settings") {
    const legacyPlatformViews: Record<string, string> = {
      "platform-ai": "ai",
      "platform-dataforseo": "dataforseo",
    }
    const replacement = legacyPlatformViews[activeView]
    if (replacement) {
      return (
        <Navigate
          to={`/projects/${projectId}/platform-settings/${replacement}`}
          replace
        />
      )
    }
  }
  if (!moduleConfig.tabs.some((tab) => tab.id === activeView)) {
    return (
      <Navigate
        to={`/projects/${projectId}/${moduleConfig.id}/${moduleConfig.tabs[0].id}`}
        replace
      />
    )
  }
  const auditAvailabilityLoaded =
    currentAuditAvailability && auditAvailability.loaded
  const auditViewDisabled =
    moduleConfig.id === "audit" &&
    activeView !== "overview" &&
    (activeView === "history"
      ? !projectHasAuditHistory
      : !projectHasCompletedAudit)
  if (auditAvailabilityLoaded && auditViewDisabled) {
    return <Navigate to={`/projects/${projectId}/audit/overview`} replace />
  }
  const auditViewAvailabilityPending =
    auditViewDisabled && !auditAvailabilityLoaded

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
      setCreateArticleOpen(true)
      return
    }
    setActionCount((count) => count + 1)
  }

  const selectedArticleId =
    moduleConfig.id === "content" ? searchParams.get("articleId") : null

  function openArticle(articleId: string) {
    navigate(
      `/projects/${project.id}/content/articles/${encodeURIComponent(articleId)}/edit`
    )
  }

  function closeArticle() {
    navigate(`/projects/${project.id}/content/library`)
  }

  const actionIcon =
    moduleConfig.id === "content" ? (
      <FilePlus2 />
    ) : moduleConfig.id === "backlinks" ? (
      <Link2 />
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
          moduleConfig.id === "platform-settings" ||
          moduleConfig.id === "keywords" ||
          (moduleConfig.id === "content" && activeView === "plans")
            ? undefined
            : moduleConfig.id === "content" && activeView === "library"
              ? "创建文章"
              : moduleConfig.id !== "content" && actionCount > 0
                ? `已添加 ${actionCount} 项`
                : moduleConfig.action
        }
        actionIcon={actionIcon}
        onAction={
          moduleConfig.id === "content" && activeView === "plans"
            ? undefined
            : handleAction
        }
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
            <TooltipProvider>
              <TabsList
                variant="line"
                className="no-scrollbar h-11 max-w-full justify-start overflow-x-auto"
              >
                {moduleConfig.tabs.map((tab) => {
                  const disabled =
                    moduleConfig.id === "audit" &&
                    tab.id !== "overview" &&
                    (tab.id === "history"
                      ? !projectHasAuditHistory
                      : !projectHasCompletedAudit)
                  const trigger = (
                    <TabsTrigger
                      key={tab.id}
                      value={tab.id}
                      disabled={disabled}
                      onPointerEnter={() => {
                        if (moduleConfig.id === "keywords") {
                          prefetchKeywordTab(projectId, tab.id)
                        }
                      }}
                      onFocus={() => {
                        if (moduleConfig.id === "keywords") {
                          prefetchKeywordTab(projectId, tab.id)
                        }
                      }}
                    >
                      {tab.label}
                    </TabsTrigger>
                  )
                  if (!disabled) return trigger
                  return (
                    <Tooltip key={tab.id}>
                      <TooltipTrigger
                        render={
                          <span
                            className="inline-flex"
                            tabIndex={0}
                            aria-label={`${tab.label}，暂不可用`}
                          />
                        }
                      >
                        {trigger}
                      </TooltipTrigger>
                      <TooltipContent>
                        {tab.id === "history"
                          ? "产生审计记录后可查看"
                          : "完成首次审计后可查看"}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </TabsList>
            </TooltipProvider>
          </Tabs>
        </div>
      )}
      <div className="min-w-0 p-4 sm:p-6 lg:p-8">
        {auditViewAvailabilityPending ? (
          <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            正在加载网站审计
          </div>
        ) : (
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
            onOpenArticle={openArticle}
            onCloseArticle={closeArticle}
          />
        )}
      </div>
      {moduleConfig.id === "content" && activeView === "library" && (
        <CreateArticleDialog
          key={`${project.id}:${project.language}`}
          projectId={project.id}
          projectLanguage={project.language}
          open={createArticleOpen}
          onOpenChange={setCreateArticleOpen}
          onCreated={(article) => openArticle(article.id)}
        />
      )}
    </div>
  )
}
