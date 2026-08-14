import * as React from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  ARTICLE_LINK_REL_OPTIONS,
  MAX_ARTICLE_LINK_LENGTH,
  normalizeArticleLinkValue,
  suggestedArticleLinkHref,
  type ArticleLinkValue,
} from "@/features/content/article-link"

type ArticleLinkDialogProps = {
  open: boolean
  value: ArticleLinkValue
  anchorText?: string
  simple?: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (value: ArticleLinkValue) => void
  onRemove?: () => void
}

export function ArticleLinkDialog({ open, ...props }: ArticleLinkDialogProps) {
  if (!open) return null
  return <ArticleLinkDialogContent {...props} />
}

function ArticleLinkDialogContent({
  value,
  anchorText,
  simple = false,
  onOpenChange,
  onSubmit,
  onRemove,
}: Omit<ArticleLinkDialogProps, "open">) {
  const [draft, setDraft] = React.useState(() => value)
  const [error, setError] = React.useState("")

  const suggestion = suggestedArticleLinkHref(draft.href)
  const rel = new Set(
    String(draft.rel || "")
      .split(/\s+/)
      .filter(Boolean)
  )

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const normalized = normalizeArticleLinkValue(draft)
    if (!normalized) {
      setError("请输入站内相对路径或完整的 HTTP/HTTPS 地址。")
      return
    }
    onSubmit(normalized)
    onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="rounded-md sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{value.href ? "编辑链接" : "添加链接"}</DialogTitle>
          <DialogDescription>
            支持以 / 开头的站内路径和完整的 HTTP/HTTPS 地址。
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          {!simple && anchorText && (
            <div className="grid gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                锚文本
              </span>
              <span className="truncate rounded-sm bg-muted px-3 py-2">
                {anchorText}
              </span>
            </div>
          )}
          <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
            URL
            <Input
              autoFocus
              value={draft.href}
              maxLength={MAX_ARTICLE_LINK_LENGTH}
              aria-invalid={Boolean(error)}
              placeholder="/guides/example/ 或 https://example.com"
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  href: event.target.value,
                }))
                setError("")
              }}
            />
          </Label>
          {suggestion && (
            <div className="flex items-center justify-between gap-3 rounded-sm border px-3 py-2 text-xs">
              <span className="min-w-0 truncate">建议补全为 {suggestion}</span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() =>
                  setDraft((current) => ({ ...current, href: suggestion }))
                }
              >
                使用
              </Button>
            </div>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {!simple && (
            <>
              <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
                链接标题
                <Input
                  value={draft.title || ""}
                  maxLength={500}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      title: event.target.value || null,
                    }))
                  }
                />
              </Label>
              <Label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.target === "_blank"}
                  onCheckedChange={(checked) =>
                    setDraft((current) => ({
                      ...current,
                      target: checked ? "_blank" : null,
                    }))
                  }
                />
                在新窗口打开
              </Label>
              <fieldset className="grid gap-2">
                <legend className="text-xs font-medium text-muted-foreground">
                  链接关系
                </legend>
                <div className="flex flex-wrap gap-4">
                  {ARTICLE_LINK_REL_OPTIONS.map((option) => (
                    <Label
                      key={option}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={rel.has(option)}
                        onCheckedChange={(checked) => {
                          const next = new Set(rel)
                          if (checked) next.add(option)
                          else next.delete(option)
                          setDraft((current) => ({
                            ...current,
                            rel: next.size ? [...next].join(" ") : null,
                          }))
                        }}
                      />
                      {option}
                    </Label>
                  ))}
                </div>
              </fieldset>
            </>
          )}
          <DialogFooter>
            {onRemove && value.href && (
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                onClick={() => {
                  onRemove()
                  onOpenChange(false)
                }}
              >
                移除链接
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit">保存链接</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
