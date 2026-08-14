import * as React from "react"
import {
  Archive,
  ArrowRight,
  CircleAlert,
  Globe2,
  Handshake,
  ListChecks,
  Pencil,
  Plus,
  RotateCcw,
  Target,
  Users,
} from "lucide-react"
import { useNavigate, useSearchParams } from "react-router"

import { ApiError } from "@/api/client"
import type { WebsiteProjectProfileRequest } from "@/api/generated/platform"
import {
  useCurrentProject,
  type Project,
  type ProjectMutation,
} from "@/app/project-context"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"

const inputLabels: Record<string, string> = {
  keywords: "核心关键词",
  products: "产品与服务",
  target_urls: "目标 URL",
  target_audiences: "目标受众",
  partnership_goals: "合作目标",
}

type ProfileFormValue = {
  name: string
  domain: string
  country: string
  targetMarket: string
  language: string
  products: string
  keywords: string
  targetUrls: string
  targetAudiences: string
  partnershipGoals: string
}

const emptyProfile: ProfileFormValue = {
  name: "",
  domain: "",
  country: "",
  targetMarket: "",
  language: "",
  products: "",
  keywords: "",
  targetUrls: "",
  targetAudiences: "",
  partnershipGoals: "",
}

function projectProfile(project: Project): ProfileFormValue {
  return {
    name: project.name,
    domain: project.domain,
    country: project.country,
    targetMarket: project.targetMarket,
    language: project.language,
    products: project.products.join("\n"),
    keywords: project.keywords.join("\n"),
    targetUrls: project.targetUrls.join("\n"),
    targetAudiences: project.targetAudiences.join("\n"),
    partnershipGoals: project.partnershipGoals.join("\n"),
  }
}

function listValue(value: string) {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ]
}

function requestBody(value: ProfileFormValue): WebsiteProjectProfileRequest {
  return {
    name: value.name.trim(),
    domain: value.domain.trim(),
    country: value.country.trim().toUpperCase(),
    target_market: value.targetMarket.trim(),
    language: value.language.trim(),
    products: listValue(value.products),
    keywords: listValue(value.keywords),
    target_urls: listValue(value.targetUrls),
    target_audiences: listValue(value.targetAudiences),
    partnership_goals: listValue(value.partnershipGoals),
  }
}

function mutationMessage(
  mutation: ProjectMutation,
  action: "create" | "update" | "restore"
) {
  const prefix =
    action === "create"
      ? "项目已创建"
      : action === "restore"
        ? "项目已恢复"
        : "项目资料已保存"
  if (mutation.backgroundStatus === "background_retryable") {
    return `${prefix}，但后台任务需要重试。`
  }
  if (mutation.backgroundStatus === "input_required") {
    return `${prefix}，仍需补全产品、关键词、目标 URL、受众或合作目标。`
  }
  return `${prefix}，推荐准备中。`
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 422) {
    const field =
      error.detail &&
      typeof error.detail === "object" &&
      "field" in error.detail &&
      typeof error.detail.field === "string"
        ? error.detail.field
        : null
    return field ? `${field} 字段不符合要求：${error.message}` : error.message
  }
  if (error instanceof ApiError && error.status === 409) {
    return error.message
  }
  return "项目操作失败，服务端事实未改变。"
}

function Field({
  label,
  value,
  onChange,
  required,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  placeholder?: string
}) {
  return (
    <label className="space-y-2 text-sm">
      <span className="font-medium">
        {label}
        {required ? " *" : ""}
      </span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        placeholder={placeholder}
      />
    </label>
  )
}

function ListField({
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  required?: boolean
}) {
  return (
    <label className="space-y-2 text-sm">
      <span className="font-medium">
        {label}
        {required ? " *" : ""}
      </span>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        className="min-h-24"
      />
    </label>
  )
}

function ProjectProfileForm({
  value,
  onChange,
  onSubmit,
  submitting,
  submitLabel,
  error,
}: {
  value: ProfileFormValue
  onChange: (value: ProfileFormValue) => void
  onSubmit: () => void
  submitting: boolean
  submitLabel: string
  error: string | null
}) {
  const set = (field: keyof ProfileFormValue, next: string) =>
    onChange({ ...value, [field]: next })

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="项目名称"
          value={value.name}
          onChange={(next) => set("name", next)}
          required
        />
        <Field
          label="主域名"
          value={value.domain}
          onChange={(next) => set("domain", next)}
          placeholder="example.com"
          required
        />
        <Field
          label="国家代码"
          value={value.country}
          onChange={(next) => set("country", next)}
          placeholder="US"
          required
        />
        <Field
          label="目标市场"
          value={value.targetMarket}
          onChange={(next) => set("targetMarket", next)}
          placeholder="United States"
          required
        />
        <Field
          label="主要语言"
          value={value.language}
          onChange={(next) => set("language", next)}
          placeholder="en"
          required
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ListField
          label="产品与服务"
          value={value.products}
          onChange={(next) => set("products", next)}
          placeholder="每行一项"
          required
        />
        <ListField
          label="核心关键词"
          value={value.keywords}
          onChange={(next) => set("keywords", next)}
          placeholder="每行一项"
          required
        />
        <ListField
          label="目标 URL"
          value={value.targetUrls}
          onChange={(next) => set("targetUrls", next)}
          placeholder="每行一个完整 URL"
          required
        />
        <ListField
          label="目标受众"
          value={value.targetAudiences}
          onChange={(next) => set("targetAudiences", next)}
          placeholder="每行一类受众"
          required
        />
        <ListField
          label="合作目标"
          value={value.partnershipGoals}
          onChange={(next) => set("partnershipGoals", next)}
          placeholder="每行一个合作目标"
          required
        />
      </div>
      {error && (
        <div className="flex items-start gap-2 border-l-2 border-destructive pl-3 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      )}
      <Button type="submit" disabled={submitting}>
        {submitting ? "正在提交..." : submitLabel}
      </Button>
    </form>
  )
}

function ValueList({
  values,
  emptyLabel,
}: {
  values: readonly string[]
  emptyLabel: string
}) {
  if (values.length === 0) {
    return <span className="text-sm text-muted-foreground">{emptyLabel}</span>
  }
  return (
    <div className="flex flex-wrap gap-2">
      {values.map((value) => (
        <Badge key={value} variant="outline">
          {value}
        </Badge>
      ))}
    </div>
  )
}

function ProjectCard({
  project,
  selected,
  onOpen,
  onEdit,
  onArchive,
  archiveDisabled,
}: {
  project: Project
  selected: boolean
  onOpen: (view: string) => void
  onEdit: () => void
  onArchive: () => void
  archiveDisabled: boolean
}) {
  const needsInput = project.inputRequired.length > 0

  return (
    <Card className={selected ? "border-primary/50" : undefined}>
      <CardHeader className="gap-3 border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe2 className="size-4 text-muted-foreground" />
              {project.name}
            </CardTitle>
            <div className="mt-1 break-all text-sm text-muted-foreground">
              {project.domain}
            </div>
          </div>
          <Badge variant={needsInput ? "outline" : "secondary"}>
            {needsInput ? "INPUT_REQUIRED" : "主数据已就绪"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6 p-5">
        <div className="grid gap-4 sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted-foreground">国家</div>
            <div className="mt-1 text-sm font-medium">{project.country}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">目标市场</div>
            <div className="mt-1 text-sm font-medium">
              {project.targetMarket}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">语言</div>
            <div className="mt-1 text-sm font-medium">{project.language}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">上下文版本</div>
            <div className="mt-1 text-sm font-medium">
              v{project.contextVersion}
            </div>
          </div>
        </div>

        {needsInput && (
          <div className="flex items-start gap-3 border-l-2 border-amber-500 pl-3">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div>
              <div className="text-sm font-medium">项目主数据需要补充</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {project.inputRequired
                  .map((field) => inputLabels[field] ?? field)
                  .join("、")}
              </div>
            </div>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ListChecks className="size-4 text-muted-foreground" />
              核心关键词
            </div>
            <ValueList values={project.keywords} emptyLabel="INPUT_REQUIRED" />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Target className="size-4 text-muted-foreground" />
              产品与服务
            </div>
            <ValueList values={project.products} emptyLabel="INPUT_REQUIRED" />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ArrowRight className="size-4 text-muted-foreground" />
              目标 URL
            </div>
            <ValueList values={project.targetUrls} emptyLabel="INPUT_REQUIRED" />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Users className="size-4 text-muted-foreground" />
              目标受众
            </div>
            <ValueList
              values={project.targetAudiences}
              emptyLabel="INPUT_REQUIRED"
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Handshake className="size-4 text-muted-foreground" />
              合作目标
            </div>
            <ValueList
              values={project.partnershipGoals}
              emptyLabel="INPUT_REQUIRED"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button onClick={() => onOpen("recommendations")}>
            推荐池
            <ArrowRight />
          </Button>
          <Button variant="outline" onClick={() => onOpen("opportunities")}>
            外链机会
          </Button>
          <Button variant="outline" onClick={onEdit}>
            <Pencil />
            编辑资料
          </Button>
          <Button
            variant="ghost"
            onClick={onArchive}
            disabled={archiveDisabled}
            title={archiveDisabled ? "至少保留一个 active 项目" : "归档项目"}
          >
            <Archive />
            归档
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ProjectProfileSettingsForm({
  currentProject,
}: {
  currentProject: Project
}) {
  const { updateProject } = useCurrentProject()
  const [value, setValue] = React.useState(() =>
    projectProfile(currentProject)
  )
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const mutation = await updateProject(
        currentProject.id,
        requestBody(value)
      )
      setValue(projectProfile(mutation.project))
      setMessage(mutationMessage(mutation, "update"))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">项目资料</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            保存会创建新的不可变 Profile 与 Promotion Target 版本。
          </p>
        </div>
        <Badge
          variant={
            currentProject.inputRequired.length > 0 ? "outline" : "secondary"
          }
        >
          {currentProject.inputRequired.length > 0
            ? "INPUT_REQUIRED"
            : `上下文 v${currentProject.contextVersion}`}
        </Badge>
      </div>
      {message && (
        <div className="border-l-2 border-primary pl-3 text-sm">{message}</div>
      )}
      <ProjectProfileForm
        value={value}
        onChange={setValue}
        onSubmit={submit}
        submitting={submitting}
        submitLabel="保存项目资料"
        error={error}
      />
    </div>
  )
}

export function ProjectProfileSettings() {
  const { currentProject } = useCurrentProject()
  if (!currentProject) {
    throw new Error(
      "ProjectProfileSettings requires an authorized current project."
    )
  }
  return (
    <ProjectProfileSettingsForm
      key={currentProject.id}
      currentProject={currentProject}
    />
  )
}

export function ProjectWorkspace() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    currentProject: activeProject,
    projects,
    archivedProjects,
    createProject,
    updateProject,
    archiveProject,
    restoreProject,
    switchProject,
  } = useCurrentProject()
  const currentProject = activeProject as Project
  const [createValue, setCreateValue] =
    React.useState<ProfileFormValue>(emptyProfile)
  const [editingProject, setEditingProject] = React.useState<Project | null>(
    null
  )
  const [editValue, setEditValue] = React.useState<ProfileFormValue | null>(
    null
  )
  const [archiveCandidate, setArchiveCandidate] =
    React.useState<Project | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const createOpen = searchParams.get("mode") === "create"

  function closeCreate() {
    const next = new URLSearchParams(searchParams)
    next.delete("mode")
    setSearchParams(next, { replace: true })
    setError(null)
  }

  async function create() {
    setSubmitting(true)
    setError(null)
    try {
      const mutation = await createProject(requestBody(createValue))
      setCreateValue(emptyProfile)
      closeCreate()
      setMessage(mutationMessage(mutation, "create"))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  async function update() {
    if (!editingProject || !editValue) return
    setSubmitting(true)
    setError(null)
    try {
      const mutation = await updateProject(
        editingProject.id,
        requestBody(editValue)
      )
      setEditingProject(null)
      setEditValue(null)
      setMessage(mutationMessage(mutation, "update"))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  async function archive() {
    if (!archiveCandidate) return
    setSubmitting(true)
    setError(null)
    try {
      await archiveProject(archiveCandidate.id)
      const next = projects.find(
        (project) => project.id !== archiveCandidate.id
      )
      setArchiveCandidate(null)
      setMessage("项目已归档，历史业务事实仍保留。")
      if (archiveCandidate.id === currentProject.id && next) {
        switchProject(next.id)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  async function restore(project: Project) {
    setSubmitting(true)
    setError(null)
    try {
      const mutation = await restoreProject(project.id)
      setMessage(mutationMessage(mutation, "restore"))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Website Projects</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            当前 Workspace 的授权项目。环境变量只决定首次默认项。
          </p>
        </div>
        <Button
          onClick={() => {
            const next = new URLSearchParams(searchParams)
            next.set("mode", "create")
            setSearchParams(next)
          }}
        >
          <Plus />
          新建项目
        </Button>
      </div>

      {message && (
        <div className="border-l-2 border-primary pl-3 text-sm">{message}</div>
      )}
      {error && (
        <div className="border-l-2 border-destructive pl-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4">
        {projects.map((project) => (
          <ProjectCard
            key={project.websiteProjectId}
            project={project}
            selected={project.id === currentProject.id}
            onOpen={(view) =>
              navigate(`/projects/${project.id}/backlinks/${view}`)
            }
            onEdit={() => {
              setError(null)
              setEditingProject(project)
              setEditValue(projectProfile(project))
            }}
            onArchive={() => setArchiveCandidate(project)}
            archiveDisabled={projects.length === 1}
          />
        ))}
      </div>

      {archivedProjects.length > 0 && (
        <section className="space-y-3 border-t pt-6">
          <h3 className="text-sm font-semibold">已归档项目</h3>
          <div className="divide-y rounded-md border">
            {archivedProjects.map((project) => (
              <div
                key={project.websiteProjectId}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {project.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {project.domain}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={submitting}
                  onClick={() => void restore(project)}
                >
                  <RotateCcw />
                  恢复
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      <Sheet
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) closeCreate()
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>新建 Website Project</SheetTitle>
            <SheetDescription>
              项目创建后立即返回；Recommendation 准备由服务端异步处理。
            </SheetDescription>
          </SheetHeader>
          <div className="px-6 pb-6">
            <ProjectProfileForm
              value={createValue}
              onChange={setCreateValue}
              onSubmit={create}
              submitting={submitting}
              submitLabel="创建项目"
              error={error}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={editingProject !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingProject(null)
            setEditValue(null)
            setError(null)
          }
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>编辑项目资料</SheetTitle>
            <SheetDescription>
              保存会创建新的不可变资料版本，不改写已有外链业务事实。
            </SheetDescription>
          </SheetHeader>
          {editingProject && editValue && (
            <div className="px-6 pb-6">
              <ProjectProfileForm
                value={editValue}
                onChange={setEditValue}
                onSubmit={update}
                submitting={submitting}
                submitLabel="保存资料"
                error={error}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={archiveCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveCandidate(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>归档 Website Project</AlertDialogTitle>
            <AlertDialogDescription>
              项目会从 active 列表移出。Recommendation、Opportunity、Draft、Gmail、
              Mail、Placement 和审计事实不会被删除或复制。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => setArchiveCandidate(null)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void archive()}
              disabled={submitting}
            >
              确认归档
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
