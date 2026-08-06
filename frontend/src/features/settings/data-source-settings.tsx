import * as React from "react"
import {
  Check,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  LoaderCircle,
  LogIn,
  PlugZap,
  RefreshCw,
  Save,
  ShieldCheck,
  Unplug,
} from "lucide-react"

import {
  disconnectGSC,
  getGSCConnection,
  getDataForSEOSettings,
  listGSCSites,
  selectGSCSite,
  startGSCOAuth,
  testDataForSEOSettings,
  updateDataForSEOSettings,
  type DataForSEOSettings,
  type DataForSEOSettingsInput,
  type SettingsSource,
  type GSCConnection,
  type GSCSite,
} from "@/api/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"

type DataSourceSettingsProps = {
  projectId: string
  projectDomain?: string
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

const emptyGSCConnection: GSCConnection = {
  oauthConfigured: false,
  oauthRedirectUri: null,
  grantConnected: false,
  propertyConnected: false,
  siteUrl: null,
  connectedAccountEmail: null,
  requiresReconnect: false,
}

function normalizedHost(value: string): string {
  try {
    const candidate = value.includes("://") ? value : `https://${value}`
    return new URL(candidate).hostname.toLocaleLowerCase().replace(/\.$/, "")
  } catch {
    return ""
  }
}

function withoutWww(value: string): string {
  return value.startsWith("www.") ? value.slice(4) : value
}

function gscSiteMatchesDomain(siteUrl: string, projectDomain: string): boolean {
  const projectHost = normalizedHost(projectDomain)
  if (!projectHost) return false
  if (siteUrl.trim().toLocaleLowerCase().startsWith("sc-domain:")) {
    const propertyHost = normalizedHost(siteUrl.split(":", 2)[1] ?? "")
    return Boolean(
      propertyHost &&
      (projectHost === propertyHost || projectHost.endsWith(`.${propertyHost}`))
    )
  }
  const propertyHost = normalizedHost(siteUrl)
  return Boolean(
    propertyHost && withoutWww(projectHost) === withoutWww(propertyHost)
  )
}

function oauthCallbackPath(): string {
  const url = new URL(window.location.href)
  url.searchParams.delete("gsc_oauth")
  return `${url.pathname}${url.search}${url.hash}`
}

function safeReturnTo(): string | null {
  const value = new URLSearchParams(window.location.search).get("returnTo")
  return value && value.startsWith("/") && !value.startsWith("//")
    ? value
    : null
}

function oauthResultFeedback(): Feedback {
  const result = new URLSearchParams(window.location.search).get("gsc_oauth")
  if (result === "authorized") {
    return {
      kind: "success",
      message: "Google 账号授权成功，请选择网站 property",
    }
  }
  if (result === "cancelled") {
    return { kind: "error", message: "你取消了 Google 授权，尚未连接" }
  }
  if (result) return { kind: "error", message: "Google 授权失败，请重试" }
  return null
}

function GSCConnectionCard({
  projectId,
  projectDomain = "",
}: DataSourceSettingsProps) {
  const [connection, setConnection] = React.useState(emptyGSCConnection)
  const [sites, setSites] = React.useState<GSCSite[]>([])
  const [selectedSite, setSelectedSite] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [sitesLoading, setSitesLoading] = React.useState(false)
  const [sitesError, setSitesError] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [editingProperty, setEditingProperty] = React.useState(false)
  const [disconnectOpen, setDisconnectOpen] = React.useState(false)
  const [feedback, setFeedback] = React.useState<Feedback>(oauthResultFeedback)
  const returnTo = safeReturnTo()

  const loadSites = React.useCallback(async () => {
    setSitesLoading(true)
    setSitesError("")
    try {
      setSites(await listGSCSites(projectId))
    } catch (error) {
      setSites([])
      try {
        const latest = await getGSCConnection(projectId)
        if (latest.requiresReconnect) {
          setConnection(latest)
          setSelectedSite(latest.siteUrl ?? "")
          setEditingProperty(false)
          return
        }
      } catch {
        // Keep the property-list error, which is the actionable failure.
      }
      setSitesError(
        error instanceof Error
          ? error.message
          : "读取 Search Console property 失败"
      )
    } finally {
      setSitesLoading(false)
    }
  }, [projectId])

  const load = React.useCallback(async () => {
    const next = await getGSCConnection(projectId)
    setConnection(next)
    setSelectedSite(next.siteUrl ?? "")
    setEditingProperty(!next.propertyConnected)
    if (next.grantConnected && !next.requiresReconnect) {
      await loadSites()
    } else {
      setSites([])
    }
  }, [loadSites, projectId])

  React.useEffect(() => {
    if (!projectId) return
    let active = true
    const params = new URLSearchParams(window.location.search)
    const oauthResult = params.get("gsc_oauth")
    if (oauthResult) {
      params.delete("gsc_oauth")
      const query = params.toString()
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
      )
    }
    void Promise.resolve()
      .then(load)
      .catch((error: unknown) => {
        if (active)
          setFeedback({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "读取 Search Console 连接失败",
          })
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [load, projectId])

  async function connect() {
    setBusy(true)
    setFeedback(null)
    try {
      const authorizationUrl = await startGSCOAuth(
        projectId,
        oauthCallbackPath()
      )
      window.location.assign(authorizationUrl)
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "连接 Search Console 失败",
      })
      setBusy(false)
    }
  }

  async function saveSite() {
    if (!selectedSite) return
    setBusy(true)
    setFeedback(null)
    try {
      setConnection(await selectGSCSite(projectId, selectedSite))
      setEditingProperty(false)
      setFeedback({
        kind: "success",
        message: "Search Console property 已连接",
      })
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "选择 property 失败",
      })
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    setFeedback(null)
    try {
      await disconnectGSC(projectId)
      await load()
      setDisconnectOpen(false)
      setFeedback({ kind: "success", message: "Search Console 已断开" })
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "断开 Search Console 失败",
      })
    } finally {
      setBusy(false)
    }
  }

  async function copyRedirectUri() {
    if (!connection.oauthRedirectUri) return
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(connection.oauthRedirectUri)
      setFeedback({ kind: "success", message: "回调地址已复制" })
    } catch {
      setFeedback({ kind: "error", message: "无法复制，请手动选择回调地址" })
    }
  }

  function propertyReason(site: GSCSite): string | null {
    if (site.permissionLevel === "siteUnverifiedUser") return "未验证"
    if (!gscSiteMatchesDomain(site.siteUrl, projectDomain)) {
      return "与项目域名不匹配"
    }
    return null
  }

  const selectableSites = sites.filter((site) => !propertyReason(site))
  const selectedSiteAvailable = selectableSites.some(
    (site) => site.siteUrl === selectedSite
  )

  const propertyPicker = (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">选择 Search Console property</p>
          <p className="mt-1 text-xs text-muted-foreground">
            只可选择已验证且与 {projectDomain || "当前项目域名"} 匹配的
            property。
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={sitesLoading || busy}
          onClick={() => void loadSites()}
        >
          <RefreshCw className={sitesLoading ? "animate-spin" : ""} />
          刷新
        </Button>
      </div>
      {sitesLoading ? (
        <div className="flex min-h-16 items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在读取 property
        </div>
      ) : sitesError ? (
        <div
          className="space-y-3 border-l-2 border-destructive pl-3"
          role="alert"
        >
          <p className="text-sm text-destructive">{sitesError}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadSites()}
          >
            <RefreshCw />
            重试
          </Button>
        </div>
      ) : sites.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          这个 Google 账号下没有 Search Console property。请先在 Search Console
          添加并验证网站，或授权其他账号。
        </p>
      ) : (
        <>
          <Select
            value={selectedSite}
            onValueChange={(value) => setSelectedSite(value ?? "")}
          >
            <SelectTrigger
              className="w-full"
              aria-label="Search Console property"
            >
              <SelectValue placeholder="选择已验证的 property" />
            </SelectTrigger>
            <SelectContent>
              {sites.map((site) => {
                const reason = propertyReason(site)
                return (
                  <SelectItem
                    key={site.siteUrl}
                    value={site.siteUrl}
                    disabled={Boolean(reason)}
                  >
                    <span className="min-w-0 truncate">{site.siteUrl}</span>
                    {reason ? (
                      <span className="text-xs text-muted-foreground">
                        {reason}
                      </span>
                    ) : null}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          {selectableSites.length === 0 ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              没有与项目域名匹配的已验证 property。请确认项目域名，或在 Google
              Search Console 中完成验证。
            </p>
          ) : null}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={busy || sitesLoading || !selectedSiteAvailable}
          onClick={saveSite}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <Save />}
          保存 property
        </Button>
        {connection.propertyConnected ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setEditingProperty(false)}
          >
            取消
          </Button>
        ) : null}
      </div>
    </div>
  )

  return (
    <section id="google-search-console" className="scroll-mt-6 space-y-6 pb-8">
      <ProviderHeading
        name="Google Search Console"
        configured={connection.propertyConnected}
        source="none"
      />
      {loading ? (
        <div className="flex h-20 items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在读取
        </div>
      ) : !connection.oauthConfigured ? (
        <div className="space-y-4 border-l-2 border-amber-500 pl-4">
          <div>
            <p className="text-sm font-medium">管理员需要先配置 Google OAuth</p>
            <p className="mt-1 text-sm text-muted-foreground">
              在 Google Cloud Console 创建 Web OAuth 客户端，启用 Search Console
              API，并注册下面的回调地址。
            </p>
          </div>
          {connection.oauthRedirectUri ? (
            <div className="flex max-w-2xl items-center gap-2">
              <Input
                readOnly
                aria-label="OAuth 回调地址"
                value={connection.oauthRedirectUri}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => void copyRedirectUri()}
                title="复制回调地址"
                aria-label="复制回调地址"
              >
                <Copy />
              </Button>
            </div>
          ) : null}
          <Button
            type="button"
            variant="outline"
            nativeButton={false}
            render={
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            <ExternalLink />
            打开 Google Cloud Console
          </Button>
        </div>
      ) : connection.requiresReconnect ? (
        <div className="space-y-4 border-l-2 border-destructive pl-4">
          <div>
            <p className="text-sm font-medium text-destructive">
              Google 授权已失效
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              可能是授权被撤销或令牌过期。重新授权后才可读取 Search Console
              数据。
            </p>
          </div>
          <Button type="button" disabled={busy} onClick={connect}>
            {busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            重新授权
          </Button>
        </div>
      ) : !connection.grantConnected ? (
        <div className="space-y-5">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-5 text-emerald-700" />
            <div>
              <p className="text-sm font-medium">
                授权读取 Search Console 数据
              </p>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                仅申请只读权限，用于读取你已验证网站的搜索查询、展示、点击和排名数据。不会修改
                Search Console 设置。
              </p>
            </div>
          </div>
          <Button type="button" disabled={busy} onClick={connect}>
            {busy ? <LoaderCircle className="animate-spin" /> : <LogIn />}
            使用 Google 授权
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 border-y py-4 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">Google 账号</p>
              <p className="mt-1 font-medium break-all">
                {connection.connectedAccountEmail || "已授权账号"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                Search Console property
              </p>
              <p className="mt-1 font-medium break-all">
                {connection.propertyConnected ? connection.siteUrl : "尚未选择"}
              </p>
            </div>
          </div>
          {editingProperty || !connection.propertyConnected
            ? propertyPicker
            : null}
          {!editingProperty && connection.propertyConnected ? (
            <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="size-4" />
              已连接，只读权限
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {connection.propertyConnected && !editingProperty ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setEditingProperty(true)}
              >
                <RefreshCw />
                更换 property
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={connect}
            >
              <LogIn />
              授权其他 Google 账号
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setDisconnectOpen(true)}
              className="text-destructive hover:text-destructive"
            >
              <Unplug />
              断开连接
            </Button>
          </div>
          {returnTo && connection.propertyConnected ? (
            <Button
              type="button"
              nativeButton={false}
              render={<a href={returnTo} />}
            >
              {returnTo?.includes("/keywords/search-performance")
                ? "返回搜索表现"
                : "返回竞品差距"}
            </Button>
          ) : null}
        </div>
      )}
      {feedback ? (
        <p
          className={
            feedback.kind === "error"
              ? "text-sm text-destructive"
              : "text-sm text-emerald-700"
          }
        >
          {feedback.message}
        </p>
      ) : null}
      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>断开 Google Search Console？</DialogTitle>
            <DialogDescription>
              将删除这个项目保存的 Google 授权和
              property。已有分析结果不会被删除，但自动发现竞争对手将无法继续读取
              GSC 数据。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              取消
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Unplug />}
              确认断开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
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

export function DataSourceSettings({
  projectId,
  projectDomain,
}: DataSourceSettingsProps) {
  return (
    <div className="max-w-3xl space-y-8">
      <GSCConnectionCard projectId={projectId} projectDomain={projectDomain} />
      <DataForSEOForm projectId={projectId} />
    </div>
  )
}
