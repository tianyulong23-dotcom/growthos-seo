import * as React from "react"
import { Check, Globe2, LoaderCircle, RefreshCw, Save } from "lucide-react"
import "./business-profile-form.css"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { BusinessProfileInput, Project } from "@/features/projects/types"

type BusinessProfileFormProps = {
  project: Project
  onSave: (input: BusinessProfileInput) => Promise<unknown>
  submitLabel?: string
  onSaved?: () => void
  onRefresh?: () => Promise<unknown>
  refreshing?: boolean
}

function linesToValues(value: string) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()))].filter(
    Boolean
  )
}

function valuesToLines(values: string[]) {
  return values.join("\n")
}

function FieldStatus({
  field,
  overriddenFields,
}: {
  field: string
  overriddenFields: string[]
}) {
  if (!overriddenFields.includes(field)) {
    return null
  }
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      已修改
    </Badge>
  )
}

export function BusinessProfileForm({
  project,
  onSave,
  submitLabel = "确认并保存",
  onSaved,
  onRefresh,
  refreshing = false,
}: BusinessProfileFormProps) {
  const profile = project.siteProfile
  const [businessName, setBusinessName] = React.useState(
    profile?.businessName || project.name
  )
  const [businessType, setBusinessType] = React.useState(
    profile?.businessType ?? ""
  )
  const [businessSummary, setBusinessSummary] = React.useState(
    profile?.businessSummary ?? ""
  )
  const [targetAudiences, setTargetAudiences] = React.useState(
    valuesToLines(profile?.targetAudiences ?? [])
  )
  const [productsServices, setProductsServices] = React.useState(
    valuesToLines(profile?.productsServices ?? [])
  )
  const [valuePropositions, setValuePropositions] = React.useState(
    valuesToLines(profile?.valuePropositions ?? [])
  )
  const [saving, setSaving] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState("")
  const [startingRefresh, setStartingRefresh] = React.useState(false)
  const confirmed = saved || Boolean(profile?.confirmedAt)
  const syncedProjectId = React.useRef(project.id)
  const editedFields = React.useRef(new Set<string>())
  const syncedRunId = React.useRef(
    project.understandingStatus === "completed" ||
      project.understandingStatus === "partial"
      ? project.understandingRunId
      : null
  )
  const busy = saving || refreshing || startingRefresh
  const showRecognitionMessage =
    Boolean(project.understandingMessage) &&
    project.understandingStatus !== "completed"
  const recognitionDescription =
    project.understandingStatus === "completed"
      ? "AI 已完成识别，可检查并修改。"
      : project.understandingStatus === "partial"
        ? "已生成部分资料，请检查并补充。"
        : project.understandingStatus === "failed"
          ? "上次识别失败，当前资料仍可修改。"
          : "AI 正在重新识别，完成后会更新这些资料。"
  React.useEffect(() => {
    const projectChanged = syncedProjectId.current !== project.id
    const recognitionFinished =
      (project.understandingStatus === "completed" ||
        project.understandingStatus === "partial") &&
      syncedRunId.current !== project.understandingRunId

    if (!projectChanged && !recognitionFinished) {
      return
    }

    if (projectChanged) editedFields.current.clear()
    if (!editedFields.current.has("businessName"))
      setBusinessName(profile?.businessName || project.name)
    if (!editedFields.current.has("businessType"))
      setBusinessType(profile?.businessType ?? "")
    if (!editedFields.current.has("businessSummary"))
      setBusinessSummary(profile?.businessSummary ?? "")
    if (!editedFields.current.has("targetAudiences"))
      setTargetAudiences(valuesToLines(profile?.targetAudiences ?? []))
    if (!editedFields.current.has("productsServices"))
      setProductsServices(valuesToLines(profile?.productsServices ?? []))
    if (!editedFields.current.has("valuePropositions"))
      setValuePropositions(valuesToLines(profile?.valuePropositions ?? []))
    setSaved(false)
    setError("")
    syncedProjectId.current = project.id
    syncedRunId.current =
      project.understandingStatus === "completed" ||
      project.understandingStatus === "partial"
        ? project.understandingRunId
        : null
  }, [
    profile,
    project.id,
    project.name,
    project.understandingRunId,
    project.understandingStatus,
  ])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setSaved(false)
    setError("")

    try {
      await onSave({
        businessName: businessName.trim(),
        businessType: businessType.trim(),
        businessSummary: businessSummary.trim(),
        targetAudiences: linesToValues(targetAudiences),
        productsServices: linesToValues(productsServices),
        valuePropositions: linesToValues(valuePropositions),
        aiContentRules: profile?.aiContentRules ?? "",
      })
      setSaved(true)
      onSaved?.()
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "确认业务资料失败"
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleRefresh() {
    if (!onRefresh) {
      return
    }
    setStartingRefresh(true)
    setError("")
    try {
      await onRefresh()
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "重新识别网站业务失败"
      )
    } finally {
      setStartingRefresh(false)
    }
  }

  return (
    <form className="business-profile-editor" onSubmit={handleSubmit}>
      <section className="profile-fields">
        <div className="profile-heading">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">业务信息</h2>
              <Badge variant={confirmed ? "secondary" : "outline"}>
                {confirmed && <Check />}
                {confirmed ? "已确认" : "待确认"}
              </Badge>
            </div>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Globe2 className="size-3.5" />
              {project.domain}
            </p>
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted-foreground">
              {recognitionDescription}
            </p>
            {showRecognitionMessage && (
              <p className="text-sm text-muted-foreground">
                {project.understandingMessage}
              </p>
            )}
          </div>
        </div>

        <h3 className="profile-section-title">基本信息</h3>
        <div data-slot="form-field" className="min-w-0 space-y-2">
          <Label htmlFor="business-name">
            企业 / 品牌名称
            <FieldStatus
              field="business_name"
              overriddenFields={profile?.userOverriddenFields ?? []}
            />
          </Label>
          <Input
            id="business-name"
            aria-label="企业 / 品牌名称"
            value={businessName}
            onChange={(event) => {
              editedFields.current.add("businessName")
              setBusinessName(event.target.value)
            }}
            disabled={busy}
            required
          />
        </div>

        <div data-slot="form-field" className="min-w-0 space-y-2">
          <Label htmlFor="business-type">
            业务类型（选填）
            <FieldStatus
              field="business_type"
              overriddenFields={profile?.userOverriddenFields ?? []}
            />
          </Label>
          <Input
            id="business-type"
            aria-label="业务类型"
            value={businessType}
            onChange={(event) => {
              editedFields.current.add("businessType")
              setBusinessType(event.target.value)
            }}
            disabled={busy}
          />
        </div>

        <div data-slot="form-field" className="profile-full-width space-y-2">
          <Label htmlFor="business-summary">
            公司简介
            <FieldStatus
              field="business_summary"
              overriddenFields={profile?.userOverriddenFields ?? []}
            />
          </Label>
          <Textarea
            id="business-summary"
            aria-label="公司简介"
            value={businessSummary}
            onChange={(event) => {
              editedFields.current.add("businessSummary")
              setBusinessSummary(event.target.value)
            }}
            className="min-h-28 resize-y"
            disabled={busy}
          />
        </div>

        <h3 className="profile-section-title">客户与产品</h3>
        <div data-slot="form-field" className="min-w-0 space-y-2">
          <Label htmlFor="target-audiences">
            目标客户
            <FieldStatus
              field="target_audiences"
              overriddenFields={profile?.userOverriddenFields ?? []}
            />
          </Label>
          <Textarea
            id="target-audiences"
            aria-label="目标客户"
            value={targetAudiences}
            onChange={(event) => {
              editedFields.current.add("targetAudiences")
              setTargetAudiences(event.target.value)
            }}
            className="min-h-40 resize-y"
            disabled={busy}
          />
        </div>

        <div data-slot="form-field" className="min-w-0 space-y-2">
          <Label htmlFor="products-services">
            产品与服务
            <FieldStatus
              field="products_services"
              overriddenFields={profile?.userOverriddenFields ?? []}
            />
          </Label>
          <Textarea
            id="products-services"
            aria-label="产品与服务"
            value={productsServices}
            onChange={(event) => {
              editedFields.current.add("productsServices")
              setProductsServices(event.target.value)
            }}
            className="min-h-40 resize-y"
            disabled={busy}
          />
        </div>

        <div data-slot="form-field" className="profile-full-width space-y-2">
          <Label htmlFor="value-propositions">
            客户为什么选择您
            <FieldStatus
              field="value_propositions"
              overriddenFields={profile?.userOverriddenFields ?? []}
            />
          </Label>
          <Textarea
            id="value-propositions"
            aria-label="客户为什么选择您"
            value={valuePropositions}
            onChange={(event) => {
              editedFields.current.add("valuePropositions")
              setValuePropositions(event.target.value)
            }}
            className="min-h-36 resize-y"
            disabled={busy}
          />
        </div>
      </section>

      <div className="profile-actions">
        <Button
          className="order-2 rounded-md"
          type="submit"
          disabled={busy || !businessName.trim()}
        >
          {saving ? (
            <LoaderCircle className="animate-spin" />
          ) : saved ? (
            <Check />
          ) : (
            <Save />
          )}
          {saving ? "保存中..." : saved ? "已确认" : submitLabel}
        </Button>
        {onRefresh && (
          <Button
            type="button"
            variant="outline"
            className="rounded-md"
            disabled={busy}
            onClick={handleRefresh}
          >
            {refreshing || startingRefresh ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            {refreshing || startingRefresh ? "正在重新识别" : "重新识别"}
          </Button>
        )}
        {error && (
          <span role="alert" className="w-full text-sm text-destructive">
            {error}
          </span>
        )}
      </div>
    </form>
  )
}
