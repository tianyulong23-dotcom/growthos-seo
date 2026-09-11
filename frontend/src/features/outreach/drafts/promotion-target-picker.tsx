import * as React from "react"
import { Pencil, Plus, Trash2 } from "lucide-react"

import { confirmPromotionTarget, getProject, getProjectOutreachReadiness } from "@/api/projects"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { OutreachProject } from "@/features/outreach/project"

export function PromotionTargetPicker({
  project, value, onChange, disabled,
}: {
  project: OutreachProject
  value: string
  onChange: (url: string) => void
  disabled: boolean
}) {
  const [urls, setUrls] = React.useState([...project.targetUrls])
  const [drafts, setDrafts] = React.useState<string[]>([])
  const [editing, setEditing] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const options = [...new Set([...urls, ...(value ? [value] : [])])]

  async function save() {
    setError(null)
    const targets = [...new Set(drafts.map((url) => url.trim()).filter(Boolean))]
    if (!targets.length) {
      setError("请至少保留一个推广页面。")
      return
    }
    try {
      for (const target of targets) {
        const parsed = new URL(target)
        const domain = project.domain.toLowerCase().replace(/^www\./, "")
        if (!["http:", "https:"].includes(parsed.protocol) ||
          parsed.username || parsed.password ||
          !(parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) {
          throw new Error("请填写当前项目域名下的完整网页地址。")
        }
      }
    } catch {
      setError("请填写当前项目域名下的完整网页地址，例如 https://example.com/product。")
      return
    }
    setSaving(true)
    try {
      const [current, readiness] = await Promise.all([
        getProject(project.id), getProjectOutreachReadiness(project.id),
      ])
      // Do not overwrite another editor's target changes made after this form opened.
      const currentUrls = current.siteProfile?.keyPages.map((page) => page.url) ?? []
      if (JSON.stringify(currentUrls) !== JSON.stringify(urls)) {
        setUrls(currentUrls)
        throw new Error("推广页面已在其他位置更新，请取消后重新编辑。")
      }
      if (current.contextVersion === undefined) {
        throw new Error("项目版本尚未就绪，请刷新后重试。")
      }
      const result = await confirmPromotionTarget(project.id, {
        confirmedTopics: current.siteProfile?.contentTopics ?? [],
        confirmedTargetUrls: targets,
        expectedProjectContextVersion: current.contextVersion,
        expectedSiteProfileVersionId: readiness.siteProfileVersionId,
      })
      setUrls(result.targetUrls)
      onChange(result.targetUrls.includes(value) ? value : result.targetUrls[0] ?? "")
      setEditing(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败，请重试。")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="draft-promotion-target" className="text-xs font-medium">推广目标页</label>
        {!editing && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled}
            onClick={() => { setDrafts(urls.length ? [...urls] : [""]); setError(null); setEditing(true) }}>
            <Pencil className="size-3.5" />管理页面
          </Button>
        )}
      </div>
      <select id="draft-promotion-target" value={value}
        onChange={(event) => onChange(event.target.value)} disabled={disabled || saving || editing}
        className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm">
        {!value && <option value="">请选择推广页面</option>}
        {options.map((url) => <option key={url} value={url}>{url}</option>)}
      </select>
      {editing && (
        <div className="space-y-3 border-y py-3">
          {drafts.map((url, index) => (
            <div key={index} className="flex min-w-0 items-center gap-2">
              <Input aria-label={`推广页面 ${index + 1}`} type="url" value={url}
                disabled={saving || disabled} className="min-w-0"
                onChange={(event) => setDrafts((current) => current.map((item, i) => i === index ? event.target.value : item))} />
              <Button type="button" variant="ghost" size="icon" title="删除页面"
                aria-label={`删除推广页面 ${index + 1}`} disabled={saving || disabled}
                onClick={() => setDrafts((current) => current.filter((_, i) => i !== index))}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={saving || disabled || drafts.length >= 100}
              onClick={() => setDrafts((current) => [...current, ""])}>
              <Plus className="size-4" />新增页面
            </Button>
            <Button type="button" size="sm" disabled={saving || disabled} onClick={() => void save()}>
              {saving ? "保存中…" : "保存"}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={saving}
              onClick={() => { setEditing(false); setError(null) }}>取消</Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
