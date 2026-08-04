import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Database,
  RefreshCw,
  Save,
  ShieldAlert,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"

import {
  isSettingsApiStatus,
  settingsClient,
} from "./api"
import type {
  KillSwitchLayer,
  KillSwitchView,
  SettingsClient,
  SettingsGovernanceView,
  SettingsValues,
} from "./types"

type ViewState =
  | "loading"
  | "ready"
  | "error"
  | "forbidden"
  | "conflict"
type SaveState = "idle" | "saving" | "saved" | "error" | "forbidden" | "conflict"

const DANGEROUS_CONFIRMATION = "CONFIRM DANGEROUS CHANGE"
const retentionLabels = {
  legal_hold: "legal_hold",
  audit_record: "audit_record",
  lifecycle_record: "lifecycle_record",
  active_suppression: "active_suppression",
} as const

function errorState(error: unknown): "error" | "forbidden" | "conflict" {
  if (isSettingsApiStatus(error, 403)) return "forbidden"
  if (isSettingsApiStatus(error, 409)) return "conflict"
  return "error"
}

function sourceLabel(sourceLayer: KillSwitchView["sourceLayer"]): string {
  if (sourceLayer === "authority_unavailable") return "权限服务不可用"
  if (sourceLayer === "default") return "安全默认值"
  return sourceLayer
}

export function SettingsWorkspace({
  websiteProjectKey,
  client = settingsClient,
}: {
  websiteProjectKey: string
  client?: SettingsClient
}) {
  const [viewState, setViewState] = useState<ViewState>("loading")
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [view, setView] = useState<SettingsGovernanceView | null>(null)
  const [values, setValues] = useState<SettingsValues | null>(null)
  const [selectedCapability, setSelectedCapability] = useState("")
  const [selectedLayer, setSelectedLayer] =
    useState<KillSwitchLayer>("project")
  const [nextBlocked, setNextBlocked] = useState(true)
  const [confirmation, setConfirmation] = useState("")
  const [reason, setReason] = useState("")

  const load = useCallback(async () => {
    setViewState("loading")
    try {
      const response = await client.getSettings(websiteProjectKey)
      setView(response)
      setValues(response.settings.values)
      setSelectedCapability((current) =>
        current || response.killSwitches[0]?.capability || ""
      )
      setViewState("ready")
    } catch (error) {
      setViewState(errorState(error))
    }
  }, [client, websiteProjectKey])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    return () => {
      active = false
    }
  }, [load])

  const selectedSwitch = useMemo(
    () =>
      view?.killSwitches.find(
        (item) => item.capability === selectedCapability
      ) ?? null,
    [selectedCapability, view]
  )

  async function saveSettings() {
    if (view === null || values === null) return
    setSaveState("saving")
    try {
      const response = await client.updateSettings(websiteProjectKey, {
        expectedVersion: view.settings.version,
        values,
      })
      setView((current) =>
        current === null ? current : { ...current, settings: response.settings }
      )
      setValues(response.settings.values)
      setSaveState("saved")
    } catch (error) {
      setSaveState(errorState(error))
    }
  }

  async function saveKillSwitch() {
    if (view === null || selectedSwitch === null) return
    setSaveState("saving")
    try {
      const response = await client.updateKillSwitch(
        websiteProjectKey,
        selectedSwitch.capability,
        {
          expectedVersion: selectedSwitch.sourceVersion ?? 0,
          layer: selectedLayer,
          provider:
            selectedLayer === "provider"
              ? selectedSwitch.provider ?? "DataForSEO"
              : null,
          blocked: nextBlocked,
          confirmation,
          reason,
        }
      )
      setView((current) =>
        current === null
          ? current
          : {
              ...current,
              killSwitches: current.killSwitches.map((item) =>
                item.capability === response.killSwitch.capability
                  ? response.killSwitch
                  : item
              ),
            }
      )
      setConfirmation("")
      setReason("")
      setSaveState("saved")
    } catch (error) {
      setSaveState(errorState(error))
    }
  }

  if (viewState === "loading") {
    return (
      <div className="space-y-4" aria-label="设置加载中">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (viewState !== "ready" || view === null || values === null) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 border-y bg-muted/20 px-6 text-center">
        <AlertTriangle className="size-6 text-destructive" />
        <h2 className="text-base font-semibold">
          {viewState === "forbidden"
            ? "无权查看治理设置"
            : viewState === "conflict"
              ? "设置版本已变化"
              : "设置读取失败"}
        </h2>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw data-icon="inline-start" />
          重新读取
        </Button>
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-7">
      <section className="flex flex-col gap-3 border-y bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">指标与治理设置</h2>
            <Badge variant="outline">version {view.settings.version}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            运行中的 Job 保持启动时绑定的设置版本。
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void load()}
          disabled={saveState === "saving"}
        >
          <RefreshCw data-icon="inline-start" />
          刷新
        </Button>
      </section>

      <section aria-labelledby="report-settings-heading">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 id="report-settings-heading" className="font-semibold">
              报告参数
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              新保存产生新版本，不覆盖历史版本。
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => void saveSettings()}
            disabled={saveState === "saving"}
          >
            <Save data-icon="inline-start" />
            保存
          </Button>
        </div>
        <div className="grid gap-4 border-y py-4 md:grid-cols-3">
          <label className="space-y-2 text-sm">
            <span className="font-medium">报告时区</span>
            <Input
              value={values.reportingTimezone}
              onChange={(event) =>
                setValues((current) =>
                  current === null
                    ? current
                    : { ...current, reportingTimezone: event.target.value }
                )
              }
            />
          </label>
          <label className="space-y-2 text-sm">
            <span className="font-medium">回看天数</span>
            <Input
              type="number"
              min={1}
              max={366}
              value={values.reportLookbackDays}
              onChange={(event) =>
                setValues((current) =>
                  current === null
                    ? current
                    : {
                        ...current,
                        reportLookbackDays: Number(event.target.value),
                      }
                )
              }
            />
          </label>
          <label className="space-y-2 text-sm">
            <span className="font-medium">导出有效期（小时）</span>
            <Input
              type="number"
              min={1}
              max={168}
              value={values.exportExpiryHours}
              onChange={(event) =>
                setValues((current) =>
                  current === null
                    ? current
                    : {
                        ...current,
                        exportExpiryHours: Number(event.target.value),
                      }
                )
              }
            />
          </label>
        </div>
      </section>

      <section aria-labelledby="kill-switch-heading">
        <div className="mb-4">
          <h3 id="kill-switch-heading" className="font-semibold">
            能力开关
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            父级阻断优先；当前页面仅提交项目或 Provider 层变更。
          </p>
        </div>
        <div className="divide-y border-y">
          {view.killSwitches.map((item) => (
            <button
              type="button"
              key={`${item.capability}:${item.provider ?? "project"}`}
              className="flex w-full items-center justify-between gap-4 py-3 text-left"
              onClick={() => {
                setSelectedCapability(item.capability)
                setNextBlocked(!item.effectiveBlocked)
              }}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {item.provider === "DataForSEO"
                    ? "DataForSEO"
                    : item.capability}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  生效来源：{sourceLabel(item.sourceLayer)}
                  {item.sourceVersion === null
                    ? ""
                    : ` · v${item.sourceVersion}`}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <Badge
                  variant={item.effectiveBlocked ? "destructive" : "secondary"}
                >
                  {item.effectiveBlocked ? "已阻断" : "可运行"}
                </Badge>
                <Switch
                  checked={!item.effectiveBlocked}
                  aria-label={`${item.capability} effectiveBlocked`}
                  readOnly
                />
              </span>
            </button>
          ))}
        </div>

        {selectedSwitch !== null && (
          <div className="mt-4 grid gap-4 border-l-2 border-destructive bg-destructive/5 p-4 lg:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
            <label className="space-y-2 text-sm">
              <span className="font-medium">变更层级</span>
              <Select
                value={selectedLayer}
                onValueChange={(value) =>
                  setSelectedLayer(value as KillSwitchLayer)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {view.editableKillSwitchLayers.map((layer) => (
                    <SelectItem key={layer} value={layer}>
                      {layer === "project" ? "项目" : "Provider"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-medium">原因</span>
              <Input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-medium">确认文本</span>
              <Input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={DANGEROUS_CONFIRMATION}
              />
            </label>
            <Button
              variant={nextBlocked ? "destructive" : "default"}
              onClick={() => void saveKillSwitch()}
              disabled={
                saveState === "saving" ||
                reason.trim() === "" ||
                confirmation !== DANGEROUS_CONFIRMATION
              }
            >
              <ShieldAlert data-icon="inline-start" />
              {nextBlocked ? "阻断" : "解除"}
            </Button>
          </div>
        )}
      </section>

      <section aria-labelledby="retention-heading">
        <div className="mb-4 flex items-start gap-3">
          <Database className="mt-0.5 size-5 text-muted-foreground" />
          <div>
            <h3 id="retention-heading" className="font-semibold">
              Retention 策略
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              只选择到期记录，不在读取路径执行删除。
            </p>
          </div>
        </div>
        <div className="overflow-x-auto border-y">
          <table className="w-full min-w-96 text-sm">
            <thead className="bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">类别</th>
                <th className="px-3 py-2 font-medium">保留天数</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {view.retention.rules.map((rule) => (
                <tr key={rule.category}>
                  <td className="px-3 py-2 font-medium">{rule.category}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {rule.retainForDays}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {view.retention.exceptions.map((exception) => (
            <Badge key={exception} variant="outline">
              {retentionLabels[exception]}
            </Badge>
          ))}
        </div>
      </section>

      {saveState === "saved" && (
        <p className="text-sm text-muted-foreground">设置已保存为新版本。</p>
      )}
      {saveState === "forbidden" && (
        <p className="text-sm text-destructive">当前账号无权修改该设置。</p>
      )}
      {saveState === "conflict" && (
        <p className="text-sm text-destructive">
          ExpectedVersion 冲突，请刷新后重新提交。
        </p>
      )}
      {saveState === "error" && (
        <p className="text-sm text-destructive">设置保存失败。</p>
      )}
    </div>
  )
}
