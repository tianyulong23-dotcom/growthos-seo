import * as React from "react"
import { LoaderCircle } from "lucide-react"

import { createArticle, type ArticleSummary } from "@/api/articles"
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

type CreateArticleDialogProps = {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (article: ArticleSummary) => void
}

export function CreateArticleDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: CreateArticleDialogProps) {
  const [keyword, setKeyword] = React.useState("")
  const [error, setError] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const submittingRef = React.useRef(false)
  const pendingRequestRef = React.useRef<{
    projectId: string
    keyword: string
    idempotencyKey: string
  } | null>(null)

  function reset() {
    setKeyword("")
    setError("")
    setSubmitting(false)
    submittingRef.current = false
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
    const normalizedKeyword = keyword.trim()
    if (!normalizedKeyword) {
      setError("请输入关键词")
      return
    }

    setError("")
    submittingRef.current = true
    setSubmitting(true)
    const pendingRequest = pendingRequestRef.current
    const idempotencyKey =
      pendingRequest?.projectId === projectId &&
      pendingRequest.keyword === normalizedKeyword
        ? pendingRequest.idempotencyKey
        : crypto.randomUUID()
    pendingRequestRef.current = {
      projectId,
      keyword: normalizedKeyword,
      idempotencyKey,
    }
    try {
      const article = await createArticle(
        projectId,
        normalizedKeyword,
        idempotencyKey
      )
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
      <DialogContent className="rounded-md sm:max-w-md" showCloseButton={!submitting}>
        <form className="grid gap-6" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>创建文章</DialogTitle>
            <DialogDescription>
              输入主关键词后，系统会自动完成资料收集、写作和检查。
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            <span className="font-medium">主关键词</span>
            <Input
              autoFocus
              value={keyword}
              maxLength={200}
              onChange={(event) => {
                const nextKeyword = event.target.value
                setKeyword(nextKeyword)
                setError("")
                if (
                  pendingRequestRef.current &&
                  nextKeyword.trim() !== pendingRequestRef.current.keyword
                ) {
                  pendingRequestRef.current = null
                }
              }}
              placeholder="例如：solar battery payback"
              aria-invalid={Boolean(error)}
              disabled={submitting}
            />
            {error && <span className="block text-xs text-destructive">{error}</span>}
          </label>
          <DialogFooter>
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
              {submitting ? "提交中..." : "生成"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
