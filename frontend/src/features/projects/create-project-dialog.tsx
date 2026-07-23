import * as React from "react"
import { Globe2, Languages, LoaderCircle, MapPin } from "lucide-react"
import { useNavigate } from "react-router"

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
import { markBusinessProfileOnboarding } from "@/features/projects/business-profile-onboarding-storage"
import {
  projectCountryOptions,
  projectLanguageOptions,
} from "@/features/projects/project-options"
import { ProjectOptionCombobox } from "@/features/projects/project-option-combobox"
import { useProjects } from "@/features/projects/project-context"

type CreateProjectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function normalizeDomain(value: string) {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) {
    return null
  }

  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`
    )
    if (!url.hostname.includes(".")) {
      return null
    }
    return url.hostname.replace(/\.$/, "").replace(/^www\./, "")
  } catch {
    return null
  }
}

export function CreateProjectDialog({
  open,
  onOpenChange,
}: CreateProjectDialogProps) {
  const navigate = useNavigate()
  const { projects, createProject } = useProjects()
  const [domain, setDomain] = React.useState("")
  const [country, setCountry] = React.useState("US")
  const [language, setLanguage] = React.useState("en")
  const [error, setError] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  function resetForm() {
    setDomain("")
    setCountry("US")
    setLanguage("en")
    setError("")
    setSubmitting(false)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (submitting && !nextOpen) {
      return
    }
    if (!nextOpen) {
      resetForm()
    }
    onOpenChange(nextOpen)
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const normalizedDomain = normalizeDomain(domain)

    if (!normalizedDomain) {
      setError("请输入有效的主域名，例如 example.com")
      return
    }
    if (
      projects.some(
        (project) => project.domain.replace(/^www\./, "") === normalizedDomain
      )
    ) {
      setError("这个域名已经创建过项目")
      return
    }

    setError("")
    setSubmitting(true)

    try {
      const project = await createProject({
        domain: normalizedDomain,
        country,
        language,
      })
      markBusinessProfileOnboarding(project.id)
      onOpenChange(false)
      resetForm()
      navigate(`/projects/${project.id}/overview`, {
        state: { waitForBusinessProfile: true },
      })
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "创建项目失败"
      )
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!submitting}>
        <form className="grid gap-6" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>新建项目</DialogTitle>
            <DialogDescription>
              创建后将立即进入项目，网站业务识别进度会显示在 AI Agent 中。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <label className="block space-y-2 text-sm">
              <span className="flex items-center gap-2 font-medium">
                <Globe2 className="size-4 text-muted-foreground" />
                主域名
              </span>
              <Input
                value={domain}
                onChange={(event) => {
                  setDomain(event.target.value)
                  setError("")
                }}
                placeholder="example.com"
                aria-invalid={Boolean(error)}
                disabled={submitting}
              />
              {error && (
                <span className="block text-xs text-destructive">{error}</span>
              )}
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <MapPin className="size-4 text-muted-foreground" />
                  国家
                </span>
                <ProjectOptionCombobox
                  value={country}
                  onValueChange={setCountry}
                  options={projectCountryOptions}
                  placeholder="选择国家"
                  searchPlaceholder="搜索国家或代码"
                  emptyText="未找到国家"
                  ariaLabel="选择国家"
                />
              </label>

              <label className="space-y-2 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <Languages className="size-4 text-muted-foreground" />
                  语言
                </span>
                <ProjectOptionCombobox
                  value={language}
                  onValueChange={setLanguage}
                  options={projectLanguageOptions}
                  placeholder="选择语言"
                  searchPlaceholder="搜索语言或代码"
                  emptyText="未找到语言"
                  ariaLabel="选择语言"
                />
              </label>
            </div>
          </div>

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
              {submitting ? "创建中..." : "创建项目"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
