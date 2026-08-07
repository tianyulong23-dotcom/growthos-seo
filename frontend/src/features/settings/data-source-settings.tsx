import * as React from "react"
import {
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  LoaderCircle,
  PlugZap,
  Save,
} from "lucide-react"

import {
  getDataForSEOSettings,
  testDataForSEOSettings,
  updateDataForSEOSettings,
  type DataForSEOSettings,
  type DataForSEOSettingsInput,
  type SettingsSource,
} from "@/api/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"

type DataSourceSettingsProps = {
  projectId: string
}

type Feedback = {
  kind: "success" | "error"
  message: string
} | null

const emptyDataForSEOSettings: DataForSEOSettings = {
  login: "",
  configured: false,
  passwordConfigured: false,
  source: "none",
  updatedAt: null,
}

function sourceName(source: SettingsSource) {
  if (source === "database") return "自定义设置"
  if (source === "environment") return "服务器默认"
  return ""
}

function ProviderHeading({
  name,
  configured,
  source,
}: {
  name: string
  configured: boolean
  source: SettingsSource
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-lg font-semibold">{name}</h2>
      <Badge variant={configured ? "outline" : "secondary"}>
        {configured ? "已配置" : "未配置"}
      </Badge>
      {source !== "none" && (
        <span className="text-xs text-muted-foreground">
          {sourceName(source)}
        </span>
      )}
    </div>
  )
}

function SecretInput({
  id,
  label,
  value,
  onChange,
  configured,
  disabled,
  placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  configured: boolean
  disabled: boolean
  placeholder: string
}) {
  const [visible, setVisible] = React.useState(false)

  return (
    <div className="block space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        {configured && (
          <span className="text-xs font-normal text-muted-foreground">
            已保存
          </span>
        )}
      </div>
      <InputGroup>
        <InputGroupInput
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={configured ? "••••••••••••" : placeholder}
          autoComplete="new-password"
          disabled={disabled}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            onClick={() => setVisible((current) => !current)}
            aria-label={visible ? `隐藏${label}` : `显示${label}`}
            title={visible ? `隐藏${label}` : `显示${label}`}
            disabled={disabled || !value}
          >
            {visible ? <EyeOff /> : <Eye />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

function SettingsActions({
  provider,
  busy,
  canSubmit,
  saving,
  testing,
  feedback,
  onTest,
}: {
  provider: string
  busy: boolean
  canSubmit: boolean
  saving: boolean
  testing: boolean
  feedback: Feedback
  onTest: () => void
}) {
  return (
    <div className="flex min-h-16 flex-wrap items-center gap-3 pt-6">
      <Button
        type="submit"
        disabled={busy || !canSubmit}
        aria-label={`保存 ${provider} 设置`}
      >
        {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
        {saving ? "保存中..." : "保存设置"}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={busy || !canSubmit}
        onClick={onTest}
        aria-label={`测试 ${provider} 连接`}
      >
        {testing ? <LoaderCircle className="animate-spin" /> : <PlugZap />}
        {testing ? "测试中..." : "测试连接"}
      </Button>
      {feedback && (
        <span
          className={
            feedback.kind === "error"
              ? "flex items-center gap-1.5 text-sm text-destructive"
              : "flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"
          }
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.kind === "error" ? <CircleAlert /> : <Check />}
          {feedback.message}
        </span>
      )}
    </div>
  )
}

function DataForSEOForm({ projectId }: DataSourceSettingsProps) {
  const [settings, setSettings] = React.useState(emptyDataForSEOSettings)
  const [login, setLogin] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [feedback, setFeedback] = React.useState<Feedback>(null)

  React.useEffect(() => {
    if (!projectId) return
    let active = true
    void getDataForSEOSettings(projectId)
      .then((loaded) => {
        if (!active) return
        setSettings(loaded)
        setLogin(loaded.login)
        setPassword("")
      })
      .catch((error: unknown) => {
        if (!active) return
        setFeedback({
          kind: "error",
          message:
            error instanceof Error ? error.message : "读取 DataForSEO 设置失败",
        })
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId])

  const busy = loading || saving || testing
  const canSubmit = Boolean(
    login.trim() && (password.trim() || settings.passwordConfigured)
  )

  function currentInput(): DataForSEOSettingsInput {
    return {
      login: login.trim(),
      ...(password.trim() ? { password: password.trim() } : {}),
    }
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setFeedback(null)
    try {
      const saved = await updateDataForSEOSettings(projectId, currentInput())
      setSettings(saved)
      setLogin(saved.login)
      setPassword("")
      setFeedback({ kind: "success", message: "DataForSEO 设置已保存" })
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "保存 DataForSEO 设置失败",
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setFeedback(null)
    try {
      const result = await testDataForSEOSettings(projectId, currentInput())
      setFeedback({ kind: "success", message: result.message })
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "DataForSEO 连接测试失败",
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <form className="border-t pt-8" onSubmit={handleSave}>
      <section className="space-y-6 pb-8">
        <ProviderHeading
          name="DataForSEO"
          configured={settings.configured}
          source={settings.source}
        />
        <p className="text-sm text-muted-foreground">
          此账号由所有网站和项目共用，保存一次后会用于关键词和搜索结果数据流程。
        </p>

        {loading ? (
          <div className="flex h-28 items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在读取
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <label
              htmlFor="dataforseo-login"
              className="block space-y-2 text-sm"
            >
              <span className="font-medium">API Login</span>
              <Input
                id="dataforseo-login"
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                placeholder="API Login"
                autoComplete="username"
                disabled={busy}
                required
              />
            </label>
            <SecretInput
              id="dataforseo-password"
              label="API Password"
              value={password}
              onChange={setPassword}
              configured={settings.passwordConfigured}
              disabled={busy}
              placeholder="API Password"
            />
          </div>
        )}
      </section>

      <SettingsActions
        provider="DataForSEO"
        busy={busy}
        canSubmit={canSubmit}
        saving={saving}
        testing={testing}
        feedback={feedback}
        onTest={handleTest}
      />
    </form>
  )
}

export function DataSourceSettings({ projectId }: DataSourceSettingsProps) {
  return (
    <div className="max-w-3xl space-y-8">
      <DataForSEOForm projectId={projectId} />
    </div>
  )
}
