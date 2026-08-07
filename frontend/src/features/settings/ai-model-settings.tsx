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
  getAIProviderSettings,
  testAIProviderSettings,
  updateAIProviderSettings,
  type AIProviderSettings,
  type AIProviderSettingsInput,
} from "@/api/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"

type AIModelSettingsProps = {
  projectId: string
}

type Feedback = {
  kind: "success" | "error"
  message: string
} | null

const emptySettings: AIProviderSettings = {
  baseUrl: "",
  model: "",
  requestTimeoutSeconds: 90,
  maxRetries: 1,
  configured: false,
  apiKeyConfigured: false,
  source: "none",
  updatedAt: null,
}

const suggestedModels = ["gpt-5.4-mini", "gpt-5.6-luna", "gpt-5.6-terra"]

type ModelOption = {
  value: string
  label: string
}

export function AIModelSettings({ projectId }: AIModelSettingsProps) {
  const [settings, setSettings] = React.useState(emptySettings)
  const [baseUrl, setBaseUrl] = React.useState("")
  const [model, setModel] = React.useState("")
  const [requestTimeoutSeconds, setRequestTimeoutSeconds] = React.useState("90")
  const [maxRetries, setMaxRetries] = React.useState("1")
  const [apiKey, setApiKey] = React.useState("")
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [feedback, setFeedback] = React.useState<Feedback>(null)

  React.useEffect(() => {
    if (!projectId) return
    let active = true
    void getAIProviderSettings(projectId)
      .then((loaded) => {
        if (!active) return
        setSettings(loaded)
        setBaseUrl(loaded.baseUrl)
        setModel(loaded.model)
        setRequestTimeoutSeconds(String(loaded.requestTimeoutSeconds))
        setMaxRetries(String(loaded.maxRetries))
        setApiKey("")
      })
      .catch((error: unknown) => {
        if (!active) return
        setFeedback({
          kind: "error",
          message: error instanceof Error ? error.message : "读取 AI 设置失败",
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
  const modelOptions = React.useMemo<ModelOption[]>(() => {
    const values = model.trim()
      ? [model.trim(), ...suggestedModels]
      : suggestedModels
    return [...new Set(values)].map((value) => ({ value, label: value }))
  }, [model])
  const selectedModel = model.trim()
    ? { value: model.trim(), label: model.trim() }
    : null
  const parsedTimeout = Number(requestTimeoutSeconds)
  const parsedRetries = Number(maxRetries)
  const canSubmit = Boolean(
    baseUrl.trim() &&
    model.trim() &&
    (apiKey.trim() || settings.apiKeyConfigured) &&
    Number.isInteger(parsedTimeout) &&
    parsedTimeout >= 10 &&
    parsedTimeout <= 180 &&
    Number.isInteger(parsedRetries) &&
    parsedRetries >= 0 &&
    parsedRetries <= 2
  )

  function currentInput(): AIProviderSettingsInput {
    return {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      requestTimeoutSeconds: parsedTimeout,
      maxRetries: parsedRetries,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setFeedback(null)
    try {
      const saved = await updateAIProviderSettings(projectId, currentInput())
      setSettings(saved)
      setBaseUrl(saved.baseUrl)
      setModel(saved.model)
      setRequestTimeoutSeconds(String(saved.requestTimeoutSeconds))
      setMaxRetries(String(saved.maxRetries))
      setApiKey("")
      setShowApiKey(false)
      setFeedback({ kind: "success", message: "AI 模型设置已保存" })
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "保存 AI 设置失败",
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setFeedback(null)
    try {
      const result = await testAIProviderSettings(projectId, currentInput())
      setFeedback({ kind: "success", message: result.message })
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "模型连接测试失败",
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <form className="max-w-3xl" onSubmit={handleSave}>
      <section className="space-y-6 border-b pb-8">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">AI 模型</h2>
          <Badge variant={settings.configured ? "outline" : "secondary"}>
            {settings.configured ? "已配置" : "未配置"}
          </Badge>
          {settings.source !== "none" && (
            <span className="text-xs text-muted-foreground">
              {settings.source === "database" ? "自定义设置" : "服务器默认"}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          此处保存的平台默认模型适用于所有网站和项目，无需重复配置。
        </p>

        {loading ? (
          <div className="flex h-28 items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在读取
          </div>
        ) : (
          <div className="grid gap-6">
            <label className="block space-y-2 text-sm">
              <span className="font-medium">接口地址</span>
              <Input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
                autoComplete="url"
                disabled={busy}
                required
              />
            </label>

            <div className="grid gap-6 sm:grid-cols-2">
              <div className="block space-y-2 text-sm">
                <label htmlFor="ai-provider-model" className="font-medium">
                  默认模型
                </label>
                <Combobox
                  items={modelOptions}
                  value={selectedModel}
                  inputValue={model}
                  onInputValueChange={(value) => setModel(value)}
                  onValueChange={(option) => {
                    if (option) setModel(option.value)
                  }}
                  itemToStringLabel={(option) => option.label}
                  itemToStringValue={(option) => option.value}
                  isItemEqualToValue={(option, selected) =>
                    option.value === selected.value
                  }
                  disabled={busy}
                  required
                  autoHighlight
                >
                  <ComboboxInput
                    id="ai-provider-model"
                    className="w-full"
                    placeholder="选择或输入模型 ID"
                    autoComplete="off"
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>输入该接口提供的模型 ID</ComboboxEmpty>
                    <ComboboxList>
                      <ComboboxCollection>
                        {(option: ModelOption) => (
                          <ComboboxItem key={option.value} value={option}>
                            {option.label}
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                <span className="block text-xs font-normal text-muted-foreground">
                  可从常用项选择，也可输入该接口实际提供的模型 ID。
                </span>
              </div>

              <div className="block space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <label htmlFor="ai-provider-api-key" className="font-medium">
                    API 密钥
                  </label>
                  {settings.apiKeyConfigured && (
                    <span className="text-xs font-normal text-muted-foreground">
                      已保存
                    </span>
                  )}
                </div>
                <InputGroup>
                  <InputGroupInput
                    id="ai-provider-api-key"
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      settings.apiKeyConfigured ? "••••••••••••" : "sk-..."
                    }
                    autoComplete="new-password"
                    disabled={busy}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      onClick={() => setShowApiKey((visible) => !visible)}
                      aria-label={
                        showApiKey ? "隐藏 API 密钥" : "显示 API 密钥"
                      }
                      title={showApiKey ? "隐藏 API 密钥" : "显示 API 密钥"}
                      disabled={busy || !apiKey}
                    >
                      {showApiKey ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </div>
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              <div className="block space-y-2 text-sm">
                <label
                  htmlFor="ai-provider-request-timeout"
                  className="font-medium"
                >
                  请求超时
                </label>
                <InputGroup>
                  <InputGroupInput
                    id="ai-provider-request-timeout"
                    type="number"
                    min={10}
                    max={180}
                    step={5}
                    value={requestTimeoutSeconds}
                    onChange={(event) =>
                      setRequestTimeoutSeconds(event.target.value)
                    }
                    inputMode="numeric"
                    disabled={busy}
                    required
                  />
                  <InputGroupAddon align="inline-end">秒</InputGroupAddon>
                </InputGroup>
              </div>

              <div className="block space-y-2 text-sm">
                <label
                  htmlFor="ai-provider-max-retries"
                  className="font-medium"
                >
                  失败重试次数
                </label>
                <Input
                  id="ai-provider-max-retries"
                  type="number"
                  min={0}
                  max={2}
                  step={1}
                  value={maxRetries}
                  onChange={(event) => setMaxRetries(event.target.value)}
                  inputMode="numeric"
                  disabled={busy}
                  required
                />
              </div>
            </div>
          </div>
        )}
      </section>

      <div className="flex min-h-16 flex-wrap items-center gap-3 pt-6">
        <Button type="submit" disabled={busy || !canSubmit}>
          {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
          {saving ? "保存中..." : "保存设置"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !canSubmit}
          onClick={handleTest}
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
    </form>
  )
}
