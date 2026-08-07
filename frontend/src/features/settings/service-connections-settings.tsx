import * as React from "react"
import {
  Check,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  Plug,
  RefreshCw,
  Unplug,
} from "lucide-react"

import {
  disconnectGSCConnection,
  disconnectWordPressConnection,
  getGSCConnection,
  getWordPressConnection,
  saveGSCConnection,
  saveWordPressConnection,
  testGSCConnection,
  testWordPressConnection,
  type GSCConnection,
  type GSCConnectionInput,
  type WordPressConnection,
  type WordPressConnectionInput,
} from "@/api/service-connections"
import { Badge } from "@/components/ui/badge"
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
import { Textarea } from "@/components/ui/textarea"
import { useGmailConnection } from "@/features/outreach/gmail/use-gmail-connection"

type LoadState = "loading" | "ready" | "error"
type Feedback = { kind: "success" | "error"; message: string } | null

type ServiceConnectionsSettingsProps = {
  projectId: string
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function ConnectionStatus({
  loadState,
  connected,
}: {
  loadState: LoadState
  connected: boolean
}) {
  if (loadState === "loading") {
    return (
      <Badge variant="secondary">
        <LoaderCircle className="animate-spin" />
        读取中
      </Badge>
    )
  }
  if (loadState === "error") {
    return <Badge variant="destructive">状态读取失败</Badge>
  }
  return (
    <Badge variant={connected ? "outline" : "secondary"}>
      {connected ? "已连接" : "未连接"}
    </Badge>
  )
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null
  return (
    <div
      className={
        feedback.kind === "error"
          ? "flex items-start gap-2 text-sm text-destructive"
          : "flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-400"
      }
      role={feedback.kind === "error" ? "alert" : "status"}
    >
      {feedback.kind === "error" ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
      ) : (
        <Check className="mt-0.5 size-4 shrink-0" />
      )}
      <span>{feedback.message}</span>
    </div>
  )
}

function ConnectionRow({
  name,
  description,
  detail,
  loadState,
  connected,
  error,
  action,
}: {
  name: string
  description: string
  detail?: string | null
  loadState: LoadState
  connected: boolean
  error?: string | null
  action: React.ReactNode
}) {
  return (
    <div className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{name}</h3>
          <ConnectionStatus loadState={loadState} connected={connected} />
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
        {detail && (
          <p className="text-xs break-all text-muted-foreground">{detail}</p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 sm:justify-end">{action}</div>
    </div>
  )
}

function GSCDialog({
  projectId,
  open,
  connection,
  onOpenChange,
  onSaved,
  onDisconnected,
}: {
  projectId: string
  open: boolean
  connection: GSCConnection
  onOpenChange: (open: boolean) => void
  onSaved: (connection: GSCConnection) => void
  onDisconnected: () => void
}) {
  const [propertyUrl, setPropertyUrl] = React.useState(connection.propertyUrl)
  const [email, setEmail] = React.useState(connection.serviceAccountEmail)
  const [privateKey, setPrivateKey] = React.useState("")
  const [busy, setBusy] = React.useState<"test" | "save" | "disconnect" | null>(
    null
  )
  const [feedback, setFeedback] = React.useState<Feedback>(null)

  const input: GSCConnectionInput = {
    propertyUrl: propertyUrl.trim(),
    serviceAccountEmail: email.trim(),
    ...(privateKey.trim() ? { privateKey: privateKey.trim() } : {}),
  }
  const canSubmit = Boolean(
    input.propertyUrl &&
    input.serviceAccountEmail &&
    (input.privateKey || connection.privateKeyConfigured)
  )

  async function handleTest() {
    setBusy("test")
    setFeedback(null)
    try {
      const result = await testGSCConnection(projectId, input)
      setFeedback({ kind: "success", message: result.message })
    } catch (error) {
      setFeedback({
        kind: "error",
        message: errorMessage(error, "GSC 连接测试失败"),
      })
    } finally {
      setBusy(null)
    }
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    setBusy("save")
    setFeedback(null)
    try {
      const saved = await saveGSCConnection(projectId, input)
      onSaved(saved)
      setPrivateKey("")
      setFeedback({ kind: "success", message: "GSC 已验证并保存" })
    } catch (error) {
      setFeedback({
        kind: "error",
        message: errorMessage(error, "保存 GSC 连接失败"),
      })
    } finally {
      setBusy(null)
    }
  }

  async function handleDisconnect() {
    setBusy("disconnect")
    setFeedback(null)
    try {
      await disconnectGSCConnection(projectId)
      onDisconnected()
      onOpenChange(false)
    } catch (error) {
      setFeedback({
        kind: "error",
        message: errorMessage(error, "断开 GSC 连接失败"),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        showCloseButton={!busy}
      >
        <form onSubmit={handleSave}>
          <DialogHeader>
            <DialogTitle>Google Search Console</DialogTitle>
            <DialogDescription>
              使用已加入 GSC 资产的服务账号进行只读访问验证。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 py-6">
            <label className="grid gap-2 text-sm">
              <span className="font-medium">GSC 资产地址</span>
              <Input
                value={propertyUrl}
                onChange={(event) => setPropertyUrl(event.target.value)}
                placeholder="https://example.com 或 sc-domain:example.com"
                disabled={Boolean(busy)}
                required
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span className="font-medium">服务账号邮箱</span>
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="seo-reader@project.iam.gserviceaccount.com"
                autoComplete="username"
                disabled={Boolean(busy)}
                required
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span className="flex items-center gap-2 font-medium">
                服务账号私钥
                {connection.privateKeyConfigured && (
                  <span className="text-xs font-normal text-muted-foreground">
                    已保存
                  </span>
                )}
              </span>
              <Textarea
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
                placeholder={
                  connection.privateKeyConfigured
                    ? "留空以继续使用已保存的私钥"
                    : "-----BEGIN PRIVATE KEY-----"
                }
                autoComplete="new-password"
                className="min-h-28 font-mono text-xs"
                disabled={Boolean(busy)}
              />
            </label>
            <FeedbackMessage feedback={feedback} />
          </div>

          <DialogFooter className="sm:justify-between">
            <div>
              {connection.status === "connected" && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDisconnect}
                  disabled={Boolean(busy)}
                >
                  {busy === "disconnect" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Unplug />
                  )}
                  断开连接
                </Button>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                onClick={handleTest}
                disabled={Boolean(busy) || !canSubmit}
              >
                {busy === "test" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Plug />
                )}
                测试连接
              </Button>
              <Button type="submit" disabled={Boolean(busy) || !canSubmit}>
                {busy === "save" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Check />
                )}
                验证并保存
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function WordPressDialog({
  projectId,
  open,
  connection,
  onOpenChange,
  onSaved,
  onDisconnected,
}: {
  projectId: string
  open: boolean
  connection: WordPressConnection
  onOpenChange: (open: boolean) => void
  onSaved: (connection: WordPressConnection) => void
  onDisconnected: () => void
}) {
  const [siteUrl, setSiteUrl] = React.useState(connection.siteUrl)
  const [username, setUsername] = React.useState(connection.username)
  const [password, setPassword] = React.useState("")
  const [busy, setBusy] = React.useState<"test" | "save" | "disconnect" | null>(
    null
  )
  const [feedback, setFeedback] = React.useState<Feedback>(null)

  const input: WordPressConnectionInput = {
    siteUrl: siteUrl.trim(),
    username: username.trim(),
    ...(password.trim() ? { applicationPassword: password.trim() } : {}),
  }
  const canSubmit = Boolean(
    input.siteUrl &&
    input.username &&
    (input.applicationPassword || connection.applicationPasswordConfigured)
  )

  async function handleTest() {
    setBusy("test")
    setFeedback(null)
    try {
      const result = await testWordPressConnection(projectId, input)
      setFeedback({ kind: "success", message: result.message })
    } catch (error) {
      setFeedback({
        kind: "error",
        message: errorMessage(error, "WordPress 连接测试失败"),
      })
    } finally {
      setBusy(null)
    }
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    setBusy("save")
    setFeedback(null)
    try {
      const saved = await saveWordPressConnection(projectId, input)
      onSaved(saved)
      setPassword("")
      setFeedback({ kind: "success", message: "WordPress 已验证并保存" })
    } catch (error) {
      setFeedback({
        kind: "error",
        message: errorMessage(error, "保存 WordPress 连接失败"),
      })
    } finally {
      setBusy(null)
    }
  }

  async function handleDisconnect() {
    setBusy("disconnect")
    setFeedback(null)
    try {
      await disconnectWordPressConnection(projectId)
      onDisconnected()
      onOpenChange(false)
    } catch (error) {
      setFeedback({
        kind: "error",
        message: errorMessage(error, "断开 WordPress 连接失败"),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        showCloseButton={!busy}
      >
        <form onSubmit={handleSave}>
          <DialogHeader>
            <DialogTitle>WordPress</DialogTitle>
            <DialogDescription>
              使用 WordPress 用户名和 Application Password 验证 REST API。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 py-6">
            <label className="grid gap-2 text-sm">
              <span className="font-medium">站点地址</span>
              <Input
                type="url"
                value={siteUrl}
                onChange={(event) => setSiteUrl(event.target.value)}
                placeholder="https://example.com"
                autoComplete="url"
                disabled={Boolean(busy)}
                required
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span className="font-medium">用户名</span>
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                disabled={Boolean(busy)}
                required
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span className="flex items-center gap-2 font-medium">
                Application Password
                {connection.applicationPasswordConfigured && (
                  <span className="text-xs font-normal text-muted-foreground">
                    已保存
                  </span>
                )}
              </span>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={
                  connection.applicationPasswordConfigured
                    ? "留空以继续使用已保存的密码"
                    : "xxxx xxxx xxxx xxxx xxxx xxxx"
                }
                autoComplete="new-password"
                disabled={Boolean(busy)}
              />
            </label>
            <FeedbackMessage feedback={feedback} />
          </div>

          <DialogFooter className="sm:justify-between">
            <div>
              {connection.status === "connected" && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDisconnect}
                  disabled={Boolean(busy)}
                >
                  {busy === "disconnect" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Unplug />
                  )}
                  断开连接
                </Button>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                onClick={handleTest}
                disabled={Boolean(busy) || !canSubmit}
              >
                {busy === "test" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Plug />
                )}
                测试连接
              </Button>
              <Button type="submit" disabled={Boolean(busy) || !canSubmit}>
                {busy === "save" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Check />
                )}
                验证并保存
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const emptyGSC: GSCConnection = {
  propertyUrl: "",
  serviceAccountEmail: "",
  privateKeyConfigured: false,
  status: "disconnected",
  verifiedAt: null,
}

const emptyWordPress: WordPressConnection = {
  siteUrl: "",
  username: "",
  applicationPasswordConfigured: false,
  verifiedUser: null,
  status: "disconnected",
  verifiedAt: null,
}

export function ServiceConnectionsSettings({
  projectId,
}: ServiceConnectionsSettingsProps) {
  const [gsc, setGSC] = React.useState(emptyGSC)
  const [wordpress, setWordPress] = React.useState(emptyWordPress)
  const [gscState, setGSCState] = React.useState<LoadState>("loading")
  const [wordpressState, setWordPressState] =
    React.useState<LoadState>("loading")
  const [gscError, setGSCError] = React.useState<string | null>(null)
  const [wordpressError, setWordPressError] = React.useState<string | null>(
    null
  )
  const [gscOpen, setGSCOpen] = React.useState(false)
  const [wordpressOpen, setWordPressOpen] = React.useState(false)
  const gmail = useGmailConnection(
    projectId,
    true,
    `/projects/${projectId}/settings/connections`
  )

  const loadGSC = React.useCallback(async () => {
    setGSCState("loading")
    setGSCError(null)
    try {
      setGSC(await getGSCConnection(projectId))
      setGSCState("ready")
    } catch (error) {
      setGSC(emptyGSC)
      setGSCState("error")
      setGSCError(errorMessage(error, "无法读取 GSC 连接状态"))
    }
  }, [projectId])

  const loadWordPress = React.useCallback(async () => {
    setWordPressState("loading")
    setWordPressError(null)
    try {
      setWordPress(await getWordPressConnection(projectId))
      setWordPressState("ready")
    } catch (error) {
      setWordPress(emptyWordPress)
      setWordPressState("error")
      setWordPressError(errorMessage(error, "无法读取 WordPress 连接状态"))
    }
  }, [projectId])

  React.useEffect(() => {
    let active = true

    void getGSCConnection(projectId)
      .then((connection) => {
        if (!active) return
        setGSC(connection)
        setGSCState("ready")
      })
      .catch((error) => {
        if (!active) return
        setGSC(emptyGSC)
        setGSCState("error")
        setGSCError(errorMessage(error, "无法读取 GSC 连接状态"))
      })

    void getWordPressConnection(projectId)
      .then((connection) => {
        if (!active) return
        setWordPress(connection)
        setWordPressState("ready")
      })
      .catch((error) => {
        if (!active) return
        setWordPress(emptyWordPress)
        setWordPressState("error")
        setWordPressError(errorMessage(error, "无法读取 WordPress 连接状态"))
      })

    return () => {
      active = false
    }
  }, [projectId])

  const gmailConnected = gmail.connection?.connectionStatus === "CONNECTED"
  const gmailNeedsAuth =
    gmail.connection?.connectionStatus === "REAUTH_REQUIRED"
  const gmailDetail = gmailConnected
    ? gmail.connection?.primaryEmail
    : gmailNeedsAuth
      ? "授权已失效，需要重新连接"
      : null

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">服务连接</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          管理当前项目使用的搜索数据、内容发布和邮箱授权。
        </p>
      </div>

      <div className="divide-y rounded-md border bg-card">
        <ConnectionRow
          name="Google Search Console"
          description="读取当前网站的自然搜索表现。"
          detail={gsc.status === "connected" ? gsc.propertyUrl : null}
          loadState={gscState}
          connected={gsc.status === "connected"}
          error={gscError}
          action={
            <>
              {gscState === "error" && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void loadGSC()}
                  title="刷新 GSC 状态"
                  aria-label="刷新 GSC 状态"
                >
                  <RefreshCw />
                </Button>
              )}
              <Button
                variant={gsc.status === "connected" ? "outline" : "default"}
                onClick={() => setGSCOpen(true)}
                disabled={gscState === "loading"}
              >
                <Plug />
                {gsc.status === "connected" ? "管理" : "连接"}
              </Button>
            </>
          }
        />
        <ConnectionRow
          name="WordPress"
          description="验证站点身份并用于后续发布内容。"
          detail={
            wordpress.status === "connected"
              ? `${wordpress.siteUrl}${wordpress.verifiedUser ? ` · ${wordpress.verifiedUser}` : ""}`
              : null
          }
          loadState={wordpressState}
          connected={wordpress.status === "connected"}
          error={wordpressError}
          action={
            <>
              {wordpressState === "error" && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void loadWordPress()}
                  title="刷新 WordPress 状态"
                  aria-label="刷新 WordPress 状态"
                >
                  <RefreshCw />
                </Button>
              )}
              <Button
                variant={
                  wordpress.status === "connected" ? "outline" : "default"
                }
                onClick={() => setWordPressOpen(true)}
                disabled={wordpressState === "loading"}
              >
                <Plug />
                {wordpress.status === "connected" ? "管理" : "连接"}
              </Button>
            </>
          }
        />
        <ConnectionRow
          name="Gmail"
          description="授权外联邮件发送和回复同步。"
          detail={gmailDetail}
          loadState={
            gmail.status === "loading" || gmail.status === "idle"
              ? "loading"
              : gmail.status === "error"
                ? "error"
                : "ready"
          }
          connected={gmailConnected}
          error={gmail.errorMessage}
          action={
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void gmail.refresh()}
                disabled={
                  gmail.status === "loading" || Boolean(gmail.busyAction)
                }
                title="刷新 Gmail 状态"
                aria-label="刷新 Gmail 状态"
              >
                <RefreshCw
                  className={gmail.status === "loading" ? "animate-spin" : ""}
                />
              </Button>
              {gmailConnected && (
                <Button
                  variant="outline"
                  onClick={() => void gmail.disconnect()}
                  disabled={Boolean(gmail.busyAction)}
                >
                  {gmail.busyAction === "disconnect" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Unplug />
                  )}
                  断开
                </Button>
              )}
              {!gmailConnected && (
                <Button
                  onClick={() => void gmail.connect()}
                  disabled={
                    gmail.status === "loading" || Boolean(gmail.busyAction)
                  }
                >
                  {gmail.busyAction === "connect" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <ExternalLink />
                  )}
                  {gmailNeedsAuth ? "重新连接" : "连接"}
                </Button>
              )}
            </>
          }
        />
      </div>

      <GSCDialog
        key={gscOpen ? "gsc-open" : "gsc-closed"}
        projectId={projectId}
        open={gscOpen}
        connection={gsc}
        onOpenChange={setGSCOpen}
        onSaved={(saved) => {
          setGSC(saved)
          setGSCState("ready")
          setGSCError(null)
        }}
        onDisconnected={() => {
          setGSC(emptyGSC)
          setGSCState("ready")
        }}
      />
      <WordPressDialog
        key={wordpressOpen ? "wordpress-open" : "wordpress-closed"}
        projectId={projectId}
        open={wordpressOpen}
        connection={wordpress}
        onOpenChange={setWordPressOpen}
        onSaved={(saved) => {
          setWordPress(saved)
          setWordPressState("ready")
          setWordPressError(null)
        }}
        onDisconnected={() => {
          setWordPress(emptyWordPress)
          setWordPressState("ready")
        }}
      />
    </div>
  )
}
