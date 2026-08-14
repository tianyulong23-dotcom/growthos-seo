import * as React from "react"
import { LoaderCircle } from "lucide-react"

import {
  createArticle,
  type ArticleSummary,
  type CreateArticleInput,
} from "@/api/articles"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { projectLanguageOptions } from "@/features/projects/project-options"
import { ProjectOptionCombobox } from "@/features/projects/project-option-combobox"

type CreateArticleDialogProps = {
  projectId: string
  projectLanguage: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (article: ArticleSummary) => void
}

type FormState = {
  keyword: string
  title: string
  language: string
}

function emptyForm(projectLanguage: string): FormState {
  return {
    keyword: "",
    title: "",
    language: projectLanguage,
  }
}

function createInput(form: FormState): CreateArticleInput {
  return {
    primary_keyword: form.keyword.trim(),
    title: form.title.trim() || null,
    language: form.language,
  }
}

export function CreateArticleDialog({
  projectId,
  projectLanguage,
  open,
  onOpenChange,
  onCreated,
}: CreateArticleDialogProps) {
  const [form, setForm] = React.useState<FormState>(() =>
    emptyForm(projectLanguage)
  )
  const [error, setError] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const submittingRef = React.useRef(false)
  const pendingRequestRef = React.useRef<{
    projectId: string
    fingerprint: string
    idempotencyKey: string
  } | null>(null)

  function reset() {
    setForm(emptyForm(projectLanguage))
    setError("")
    setSubmitting(false)
    submittingRef.current = false
    pendingRequestRef.current = null
  }

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
    setError("")
    pendingRequestRef.current = null
  }

  function handleOpenChange(nextOpen: boolean) {
    if (submitting && !nextOpen) return
    if (!nextOpen) reset()
    onOpenChange(nextOpen)
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (submittingRef.current) return
    const input = createInput(form)
    if (!input.primary_keyword) {
      setError("请输入关键词")
      return
    }

    const fingerprint = JSON.stringify(input)
    const pendingRequest = pendingRequestRef.current
    const idempotencyKey =
      pendingRequest?.projectId === projectId &&
      pendingRequest.fingerprint === fingerprint
        ? pendingRequest.idempotencyKey
        : crypto.randomUUID()
    pendingRequestRef.current = { projectId, fingerprint, idempotencyKey }
    setError("")
    submittingRef.current = true
    setSubmitting(true)
    try {
      const article = await createArticle(projectId, input, idempotencyKey)
      onOpenChange(false)
      reset()
      onCreated(article)
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "创建文章失败"
      )
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] gap-0 overflow-y-auto rounded-lg p-0 sm:max-w-3xl"
        showCloseButton={!submitting}
      >
        <form onSubmit={handleSubmit}>
          <DialogHeader className="px-6 py-5 pr-14 text-left sm:px-7 sm:py-6 sm:pr-16">
            <DialogTitle className="text-lg leading-6">
              创建文章生成任务
            </DialogTitle>
            <DialogDescription className="leading-5">
              输入目标关键词。系统会先分析搜索结果，再确定文章类型和内容结构。
            </DialogDescription>
          </DialogHeader>

          <Separator />

          <div className="grid gap-5 px-6 py-6 sm:px-7">
            <div className="grid gap-2">
              <Label htmlFor="create-article-keyword">关键词</Label>
              <Input
                id="create-article-keyword"
                autoFocus
                value={form.keyword}
                maxLength={200}
                onChange={(event) => updateForm("keyword", event.target.value)}
                placeholder="输入用户真实搜索词"
                aria-invalid={Boolean(error && !form.keyword.trim())}
                disabled={submitting}
              />
              {error && !form.keyword.trim() && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>

            <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_14rem]">
              <div className="grid min-w-0 content-start gap-2">
                <Label htmlFor="create-article-title">标题（可选）</Label>
                <Input
                  id="create-article-title"
                  value={form.title}
                  maxLength={300}
                  onChange={(event) => updateForm("title", event.target.value)}
                  placeholder="留空则自动生成"
                  disabled={submitting}
                />
              </div>

              <div className="grid min-w-0 content-start gap-2">
                <Label>语言</Label>
                <ProjectOptionCombobox
                  value={form.language}
                  onValueChange={(value) => updateForm("language", value)}
                  options={projectLanguageOptions}
                  placeholder="选择语言"
                  searchPlaceholder="搜索语言或代码"
                  emptyText="未找到语言"
                  ariaLabel="选择文章语言"
                  disabled={submitting}
                />
                <p className="text-xs text-muted-foreground">
                  默认继承当前项目
                </p>
              </div>
            </div>

            {error && form.keyword.trim() && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            {submitting && (
              <div
                className="flex min-h-10 items-center gap-2 rounded-md border bg-muted/50 px-3 text-sm font-medium text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <LoaderCircle className="size-4 animate-spin" />
                <span>正在创建文章任务</span>
              </div>
            )}
          </div>

          <Separator />

          <DialogFooter className="px-6 py-4 sm:px-7">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <LoaderCircle className="animate-spin" />}
              {submitting ? "正在提交" : "开始生成"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
