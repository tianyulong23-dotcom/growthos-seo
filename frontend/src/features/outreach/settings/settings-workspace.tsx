import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Database, RefreshCw, Save, ShieldAlert } from "lucide-react"

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
import { Switch } from "@/components/ui/switch"
import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import { isOutreachOffline } from "@/features/outreach/shared/outreach-network-state"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"

import { isSettingsApiStatus, settingsClient } from "./api"
import type {
  KillSwitchLayer,
  KillSwitchView,
  SettingsClient,
  SettingsGovernanceView,
  SettingsValues,
} from "./types"

type ViewState =
  "loading" | "ready" | "error" | "forbidden" | "conflict" | "offline"
type SaveState =
  "idle" | "saving" | "saved" | "error" | "forbidden" | "conflict" | "offline"

const DANGEROUS_CONFIRMATION = "CONFIRM DANGEROUS CHANGE"
const retentionExplanations = {
  legal_hold: {
    label: "legal_hold",
    description: "法律保全中的记录不进入到期选择结果。",
  },
  audit_record: {
    label: "audit_record",
    description: "审计记录按治理要求保留，不由普通 Retention 选择。",
  },
  lifecycle_record: {
    label: "lifecycle_record",
    description: "生命周期事实用于重建状态，不在读取路径删除。",
  },
  active_suppression: {
    label: "active_suppression",
    description: "仍生效的抑制记录保留，避免恢复已阻止的操作。",
  },
} as const

function errorState(
  error: unknown
): "error" | "forbidden" | "conflict" | "offline" {
  if (isOutreachOffline()) return "offline"
  if (isSettingsApiStatus(error, 403)) return "forbidden"
  if (isSettingsApiStatus(error, 409)) return "conflict"
  return "error"
}

function sourceLabel(sourceLayer: KillSwitchView["sourceLayer"]): string {
  if (sourceLayer === "authority_unavailable") return "权限服务不可用"
  if (sourceLayer === "default") return "安全默认值"
  return sourceLayer
}

function killSwitchKey(item: KillSwitchView): string {
  return `${item.capability}\u0000${item.provider ?? ""}`
}

function editableLayersForSwitch(
  view: SettingsGovernanceView,
  item: KillSwitchView
): KillSwitchLayer[] {
  return view.editableKillSwitchLayers.filter(
    (layer) => layer === "project" || item.provider !== null
  )
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
  const [selectedSwitchKey, setSelectedSwitchKey] = useState("")
  const [selectedLayer, setSelectedLayer] = useState<KillSwitchLayer>("project")
  const [nextBlocked, setNextBlocked] = useState(true)
  const [confirmation, setConfirmation] = useState("")
  const [reason, setReason] = useState("")
  const loadRequest = useRef(0)
  const settingsKey = useMemo(
    () => createProjectQueryKey(websiteProjectKey, "settings-governance"),
    [websiteProjectKey]
  )

  const load = useCallback(
    async (force = false) => {
      const request = ++loadRequest.current
      if (force) backlinksProjectQueries.invalidate(settingsKey)
      setViewState("loading")
      try {
        const response = await backlinksProjectQueries.fetch(
          settingsKey,
          (signal) => client.getSettings(websiteProjectKey, signal)
        )
        if (request !== loadRequest.current) return
        setView(response)
        setValues(response.settings.values)
        const selected =
          response.killSwitches.find((item) => item.editable) ??
          response.killSwitches[0] ??
          null
        setSelectedSwitchKey(selected === null ? "" : killSwitchKey(selected))
        setSelectedLayer(
          selected === null
            ? "project"
            : (editableLayersForSwitch(response, selected)[0] ?? "project")
        )
        setSaveState("idle")
        setViewState("ready")
      } catch (error) {
        if (request !== loadRequest.current) return
        if (error instanceof DOMException && error.name === "AbortError") return
        setViewState(errorState(error))
      }
    },
    [client, settingsKey, websiteProjectKey]
  )

  useEffect(() => {
    queueMicrotask(() => void load())
    return () => {
      loadRequest.current += 1
      backlinksProjectQueries.invalidate(settingsKey)
    }
  }, [load, settingsKey])

  const selectedSwitch = useMemo(
    () =>
      view?.killSwitches.find(
        (item) => killSwitchKey(item) === selectedSwitchKey
      ) ?? null,
    [selectedSwitchKey, view]
  )
  const editableLayers = useMemo(
    () =>
      view === null || selectedSwitch === null
        ? []
        : editableLayersForSwitch(view, selectedSwitch),
    [selectedSwitch, view]
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
      backlinksProjectQueries.invalidate(settingsKey)
      setSaveState("saved")
    } catch (error) {
      setSaveState(errorState(error))
    }
  }

  async function saveKillSwitch() {
    if (
      view === null ||
      selectedSwitch === null ||
      !selectedSwitch.editable ||
      !editableLayers.includes(selectedLayer)
    ) {
      return
    }
    const provider =
      selectedLayer === "provider" ? selectedSwitch.provider : null
    if (selectedLayer === "provider" && provider === null) return
    setSaveState("saving")
    try {
      const response = await client.updateKillSwitch(
        websiteProjectKey,
        selectedSwitch.capability,
        {
          expectedVersion: selectedSwitch.sourceVersion ?? 0,
          layer: selectedLayer,
          provider,
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
                killSwitchKey(item) === selectedSwitchKey
                  ? response.killSwitch
                  : item
              ),
            }
      )
      setSelectedSwitchKey(killSwitchKey(response.killSwitch))
      setConfirmation("")
      setReason("")
      backlinksProjectQueries.invalidate(settingsKey)
      setSaveState("saved")
    } catch (error) {
      setSaveState(errorState(error))
    }
  }

  if (viewState === "loading") {
    return <OutreachStandardStateView state="loading" title="设置加载中" />
  }

  if (viewState !== "ready" || view === null || values === null) {
    return (
      <OutreachStandardStateView
        state={viewState === "ready" ? "error" : viewState}
        title={
          viewState === "forbidden"
            ? "无权查看治理设置"
            : viewState === "conflict"
              ? "设置版本已变化"
              : viewState === "offline"
                ? "治理设置当前离线"
                : "设置读取失败"
        }
        description="不会使用本地值覆盖服务端治理设置。"
        onRetry={() => void load(true)}
        retryLabel="重新读取"
      />
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
          <p className="mt-1 text-xs text-muted-foreground">
            刷新仅重新读取治理视图，不触发 Provider 请求。
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void load(true)}
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
              aria-pressed={killSwitchKey(item) === selectedSwitchKey}
              className="flex w-full items-center justify-between gap-4 py-3 text-left"
              onClick={() => {
                const layers = editableLayersForSwitch(view, item)
                setSelectedSwitchKey(killSwitchKey(item))
                setSelectedLayer(layers[0] ?? "project")
                setNextBlocked(!item.effectiveBlocked)
                setConfirmation("")
                setReason("")
                setSaveState("idle")
              }}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {item.provider ?? item.capability}
                </span>
                {item.provider !== null && (
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {item.capability}
                  </span>
                )}
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

        {selectedSwitch !== null &&
          selectedSwitch.editable &&
          editableLayers.length > 0 && (
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
                    {editableLayers.map((layer) => (
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
                <span className="block text-xs text-muted-foreground">
                  ExpectedVersion {selectedSwitch.sourceVersion ?? 0}
                </span>
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
        {selectedSwitch !== null &&
          (!selectedSwitch.editable || editableLayers.length === 0) && (
            <div className="mt-4 border-l-2 border-muted-foreground/40 bg-muted/20 p-4 text-sm text-muted-foreground">
              当前有效状态来自不可操作层级，仅供查看。此页面不会提供 global、
              organization 或 workspace 层修改入口。
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
        <div className="mt-3 divide-y border-y">
          {view.retention.exceptions.map((exception) => {
            const explanation = retentionExplanations[exception]
            return (
              <div
                key={exception}
                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:gap-3"
              >
                <Badge variant="outline">{explanation.label}</Badge>
                <p className="text-sm text-muted-foreground">
                  {explanation.description}
                </p>
              </div>
            )
          })}
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
      {saveState === "offline" && (
        <OutreachStandardStateView
          state="offline"
          title="设置保存请求当前离线"
          description="本地编辑不会被当作已保存的服务端版本。"
          compact
        />
      )}
    </div>
  )
}
