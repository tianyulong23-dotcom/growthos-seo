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
  type AIAPIProtocol,
  type AIProviderName,
  type AIReasoningEffort,
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
import { Label } from "@/components/ui/label"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type AIModelSettingsProps = {
  projectId: string
}

type Feedback = {
  kind: "success" | "error"
  message: string
} | null

const emptySettings: AIProviderSettings = {
  provider: "openai",
  apiProtocol: "chat_completions",
  baseUrl: "",
  model: "",
  businessModel: null,
  keywordModel: null,
  contentModel: null,
  agentModel: null,
  reasoningEffort: "medium",
  businessReasoningEffort: null,
  keywordReasoningEffort: null,
  contentReasoningEffort: null,
  agentReasoningEffort: null,
  requestTimeoutSeconds: 90,
  maxRetries: 1,
  configured: false,
  apiKeyConfigured: false,
  source: "none",
  updatedAt: null,
}

const suggestedModels = [
  "gpt-5.4-mini",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
const providerLabels: Record<AIProviderName, string> = {
  openai: "OpenAI 兼容接口",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
}
const protocolLabels: Record<AIAPIProtocol, string> = {
  chat_completions: "Chat Completions",
  responses: "Responses API",
}

type ModelOption = {
  value: string
  label: string
}

type TaskModelFieldProps = {
  id: string
  label: string
  description: string
  value: string
  defaultModel: string
  reasoningEffort: AIReasoningEffort | ""
  defaultReasoningEffort: AIReasoningEffort
  disabled: boolean
  onChange: (value: string) => void
  onReasoningEffortChange: (value: AIReasoningEffort | "") => void
}

const reasoningEffortLabels: Record<AIReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
}

function TaskModelField({
  id,
  label,
  description,
  value,
  defaultModel,
  reasoningEffort,
  defaultReasoningEffort,
  disabled,
  onChange,
  onReasoningEffortChange,
}: TaskModelFieldProps) {
  const options = React.useMemo<ModelOption[]>(() => {
    const values = [
      value.trim(),
      defaultModel.trim(),
      ...suggestedModels,
    ].filter(Boolean)
    return [...new Set(values)].map((item) => ({ value: item, label: item }))
  }, [defaultModel, value])
  const selected = value.trim()
    ? { value: value.trim(), label: value.trim() }
    : null

  return (
    <div className="block space-y-2 text-sm">
      <Label htmlFor={id} className="font-medium">
        {label}
      </Label>
      <Combobox
        items={options}
        value={selected}
        inputValue={value}
        onInputValueChange={onChange}
        onValueChange={(option) => onChange(option?.value ?? "")}
        itemToStringLabel={(option) => option.label}
        itemToStringValue={(option) => option.value}
        isItemEqualToValue={(option, current) => option.value === current.value}
        disabled={disabled}
        autoHighlight
      >
        <ComboboxInput
          id={id}
          className="w-full"
          placeholder={`使用默认模型（${defaultModel || "未设置"}）`}
          autoComplete="off"
        />
        <ComboboxContent>
          <ComboboxEmpty>输入该接口实际提供的模型 ID</ComboboxEmpty>
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
        {description}
      </span>
      <div className="space-y-2 pt-1">
        <Label htmlFor={`${id}-reasoning-effort`} className="font-medium">
          {label.replace("模型", "")}推理强度
        </Label>
        <Select
          value={reasoningEffort || "inherit"}
          onValueChange={(next) =>
            onReasoningEffortChange(
              next === "inherit" ? "" : (next as AIReasoningEffort)
            )
          }
          disabled={disabled}
        >
          <SelectTrigger id={`${id}-reasoning-effort`} className="w-full">
            <SelectValue>
              {reasoningEffort
                ? reasoningEffortLabels[reasoningEffort]
                : `使用默认（${reasoningEffortLabels[defaultReasoningEffort]}）`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">
              使用默认（{reasoningEffortLabels[defaultReasoningEffort]}）
            </SelectItem>
            <SelectItem value="low">低（更快、更省）</SelectItem>
            <SelectItem value="medium">中（速度和质量平衡）</SelectItem>
            <SelectItem value="high">高（更慢、成本更高）</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

export function AIModelSettings({ projectId }: AIModelSettingsProps) {
  const [settings, setSettings] = React.useState(emptySettings)
  const [provider, setProvider] = React.useState<AIProviderName>("openai")
  const [apiProtocol, setAPIProtocol] =
    React.useState<AIAPIProtocol>("chat_completions")
  const [baseUrl, setBaseUrl] = React.useState("")
  const [model, setModel] = React.useState("")
  const [businessModel, setBusinessModel] = React.useState("")
  const [keywordModel, setKeywordModel] = React.useState("")
  const [contentModel, setContentModel] = React.useState("")
  const [agentModel, setAgentModel] = React.useState("")
  const [reasoningEffort, setReasoningEffort] =
    React.useState<AIReasoningEffort>("medium")
  const [businessReasoningEffort, setBusinessReasoningEffort] = React.useState<
    AIReasoningEffort | ""
  >("")
  const [keywordReasoningEffort, setKeywordReasoningEffort] = React.useState<
    AIReasoningEffort | ""
  >("")
  const [contentReasoningEffort, setContentReasoningEffort] = React.useState<
    AIReasoningEffort | ""
  >("")
  const [agentReasoningEffort, setAgentReasoningEffort] = React.useState<
    AIReasoningEffort | ""
  >("")
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
        setProvider(loaded.provider)
        setAPIProtocol(loaded.apiProtocol)
        setBaseUrl(loaded.baseUrl)
        setModel(loaded.model)
        setBusinessModel(loaded.businessModel ?? "")
        setKeywordModel(loaded.keywordModel ?? "")
        setContentModel(loaded.contentModel ?? "")
        setAgentModel(loaded.agentModel ?? "")
        setReasoningEffort(loaded.reasoningEffort)
        setBusinessReasoningEffort(loaded.businessReasoningEffort ?? "")
        setKeywordReasoningEffort(loaded.keywordReasoningEffort ?? "")
        setContentReasoningEffort(loaded.contentReasoningEffort ?? "")
        setAgentReasoningEffort(loaded.agentReasoningEffort ?? "")
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
      provider,
      apiProtocol,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      businessModel: businessModel.trim() || null,
      keywordModel: keywordModel.trim() || null,
      contentModel: contentModel.trim() || null,
      agentModel: agentModel.trim() || null,
      reasoningEffort,
      businessReasoningEffort: businessReasoningEffort || null,
      keywordReasoningEffort: keywordReasoningEffort || null,
      contentReasoningEffort: contentReasoningEffort || null,
      agentReasoningEffort: agentReasoningEffort || null,
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
      setProvider(saved.provider)
      setAPIProtocol(saved.apiProtocol)
      setBaseUrl(saved.baseUrl)
      setModel(saved.model)
      setBusinessModel(saved.businessModel ?? "")
      setKeywordModel(saved.keywordModel ?? "")
      setContentModel(saved.contentModel ?? "")
      setAgentModel(saved.agentModel ?? "")
      setReasoningEffort(saved.reasoningEffort)
      setBusinessReasoningEffort(saved.businessReasoningEffort ?? "")
      setKeywordReasoningEffort(saved.keywordReasoningEffort ?? "")
      setContentReasoningEffort(saved.contentReasoningEffort ?? "")
      setAgentReasoningEffort(saved.agentReasoningEffort ?? "")
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
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="block space-y-2 text-sm">
                <Label htmlFor="ai-provider" className="font-medium">
                  接口类型
                </Label>
                <Select
                  value={provider}
                  onValueChange={(value) =>
                    setProvider(value as AIProviderName)
                  }
                  disabled={busy}
                >
                  <SelectTrigger id="ai-provider" className="w-full">
                    <SelectValue>{providerLabels[provider]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI 兼容接口</SelectItem>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                  </SelectContent>
                </Select>
                <span className="block text-xs font-normal text-muted-foreground">
                  决定请求协议；OpenAI、DeepSeek 等兼容接口选择第一项。
                </span>
              </div>

              <Label className="block space-y-2 text-sm">
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
              </Label>
            </div>

            <div className="block space-y-2 text-sm sm:max-w-[calc(50%-0.75rem)]">
              <Label htmlFor="ai-api-protocol" className="font-medium">
                调用协议
              </Label>
              <Select
                value={apiProtocol}
                onValueChange={(value) =>
                  setAPIProtocol(value as AIAPIProtocol)
                }
                disabled={busy || provider === "anthropic"}
              >
                <SelectTrigger id="ai-api-protocol" className="w-full">
                  <SelectValue>{protocolLabels[apiProtocol]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat_completions">
                    Chat Completions
                  </SelectItem>
                  <SelectItem value="responses">Responses API</SelectItem>
                </SelectContent>
              </Select>
              <span className="block text-xs font-normal text-muted-foreground">
                按模型网关实际支持的请求格式选择，不根据模型名称自动判断。
              </span>
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              <div className="block space-y-2 text-sm">
                <Label htmlFor="ai-provider-model" className="font-medium">
                  默认模型
                </Label>
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
                <Label
                  htmlFor="ai-provider-reasoning-effort"
                  className="font-medium"
                >
                  默认推理强度
                </Label>
                <Select
                  value={reasoningEffort}
                  onValueChange={(value) =>
                    setReasoningEffort(value as AIReasoningEffort)
                  }
                  disabled={busy}
                >
                  <SelectTrigger
                    id="ai-provider-reasoning-effort"
                    className="w-full"
                  >
                    <SelectValue>
                      {reasoningEffortLabels[reasoningEffort]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">低（更快、更省）</SelectItem>
                    <SelectItem value="medium">中（速度和质量平衡）</SelectItem>
                    <SelectItem value="high">高（更慢、成本更高）</SelectItem>
                  </SelectContent>
                </Select>
                <span className="block text-xs font-normal text-muted-foreground">
                  未单独设置的工作会使用此强度。
                </span>
              </div>

              <div className="block space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <Label htmlFor="ai-provider-api-key" className="font-medium">
                    API 密钥
                  </Label>
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

            <div className="space-y-4 border-t pt-6">
              <div>
                <h3 className="text-sm font-medium">按工作分配模型</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  留空时使用上面的默认模型。
                </p>
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <TaskModelField
                  id="ai-business-model"
                  label="业务识别模型"
                  description="网站业务资料识别和竞品分析"
                  value={businessModel}
                  defaultModel={model.trim()}
                  reasoningEffort={businessReasoningEffort}
                  defaultReasoningEffort={reasoningEffort}
                  disabled={busy}
                  onChange={setBusinessModel}
                  onReasoningEffortChange={setBusinessReasoningEffort}
                />
                <TaskModelField
                  id="ai-keyword-model"
                  label="关键词模型"
                  description="关键词筛选、分类和去重"
                  value={keywordModel}
                  defaultModel={model.trim()}
                  reasoningEffort={keywordReasoningEffort}
                  defaultReasoningEffort={reasoningEffort}
                  disabled={busy}
                  onChange={setKeywordModel}
                  onReasoningEffortChange={setKeywordReasoningEffort}
                />
                <TaskModelField
                  id="ai-content-model"
                  label="内容模型"
                  description="内容计划、研究、写作、检查和编辑器改写"
                  value={contentModel}
                  defaultModel={model.trim()}
                  reasoningEffort={contentReasoningEffort}
                  defaultReasoningEffort={reasoningEffort}
                  disabled={busy}
                  onChange={setContentModel}
                  onReasoningEffortChange={setContentReasoningEffort}
                />
                <TaskModelField
                  id="ai-agent-model"
                  label="Agent 模型"
                  description="SEO Agent 推理、工具调用和结果检查"
                  value={agentModel}
                  defaultModel={model.trim()}
                  reasoningEffort={agentReasoningEffort}
                  defaultReasoningEffort={reasoningEffort}
                  disabled={busy}
                  onChange={setAgentModel}
                  onReasoningEffortChange={setAgentReasoningEffort}
                />
              </div>
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              <div className="block space-y-2 text-sm">
                <Label
                  htmlFor="ai-provider-request-timeout"
                  className="font-medium"
                >
                  请求超时
                </Label>
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
                <Label
                  htmlFor="ai-provider-max-retries"
                  className="font-medium"
                >
                  失败重试次数
                </Label>
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
