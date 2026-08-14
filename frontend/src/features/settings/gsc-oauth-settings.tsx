import * as React from "react"
import {
  Check,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  LoaderCircle,
  Save,
} from "lucide-react"

import {
  getGSCOAuthSettings,
  updateGSCOAuthSettings,
  type GSCOAuthSettings,
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

type GSCOAuthSettingsProps = {
  projectId: string
}

type Feedback = {
  kind: "success" | "error"
  message: string
} | null

const emptySettings: GSCOAuthSettings = {
  clientId: "",
  configured: false,
  clientSecretConfigured: false,
  oauthRedirectUri: "",
  source: "none",
  updatedAt: null,
}

export function GSCOAuthSettings({ projectId }: GSCOAuthSettingsProps) {
  const [settings, setSettings] = React.useState(emptySettings)
  const [clientId, setClientId] = React.useState("")
  const [clientSecret, setClientSecret] = React.useState("")
  const [showSecret, setShowSecret] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [feedback, setFeedback] = React.useState<Feedback>(null)

  React.useEffect(() => {
    if (!projectId) return
    let active = true
    void getGSCOAuthSettings(projectId)
      .then((loaded) => {
        if (!active) return
        setSettings(loaded)
        setClientId(loaded.clientId)
        setClientSecret("")
      })
      .catch((error: unknown) => {
        if (!active) return
        setFeedback({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "读取 Google OAuth 设置失败",
        })
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId])

  const canSubmit = Boolean(
    clientId.trim() && (clientSecret.trim() || settings.clientSecretConfigured)
  )

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setFeedback(null)
    try {
      const saved = await updateGSCOAuthSettings(projectId, {
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      })
      setSettings(saved)
      setClientId(saved.clientId)
      setClientSecret("")
      setShowSecret(false)
      setFeedback({
        kind: "success",
        message: "Google OAuth 设置已保存，项目成员现在可以连接 Search Console",
      })
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "保存 Google OAuth 设置失败",
      })
    } finally {
      setSaving(false)
    }
  }

  async function copyRedirectUri() {
    if (!settings.oauthRedirectUri) return
    await navigator.clipboard.writeText(settings.oauthRedirectUri)
    setFeedback({ kind: "success", message: "授权回调地址已复制" })
  }

  return (
    <form className="max-w-3xl" onSubmit={handleSave}>
      <section className="space-y-6 border-b pb-8">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Google OAuth</h2>
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
          此处保存的平台 OAuth
          客户端由所有项目共用，项目成员可在服务连接中授权自己的 Google 账号。
        </p>

        {loading ? (
          <div className="flex h-28 items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在读取
          </div>
        ) : (
          <div className="grid gap-6">
            <label
              htmlFor="gsc-oauth-client-id"
              className="block space-y-2 text-sm"
            >
              <span className="font-medium">OAuth Client ID</span>
              <Input
                id="gsc-oauth-client-id"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="000000000000-example.apps.googleusercontent.com"
                autoComplete="off"
                disabled={saving}
                required
              />
            </label>

            <div className="block space-y-2 text-sm">
              <label htmlFor="gsc-oauth-client-secret" className="font-medium">
                OAuth Client Secret
              </label>
              <InputGroup>
                <InputGroupInput
                  id="gsc-oauth-client-secret"
                  type={showSecret ? "text" : "password"}
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  placeholder={
                    settings.clientSecretConfigured
                      ? "已保存，留空则保持不变"
                      : "OAuth Client Secret"
                  }
                  autoComplete="new-password"
                  disabled={saving}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    type="button"
                    onClick={() => setShowSecret((current) => !current)}
                    aria-label={
                      showSecret
                        ? "隐藏 OAuth Client Secret"
                        : "显示 OAuth Client Secret"
                    }
                    title={
                      showSecret
                        ? "隐藏 OAuth Client Secret"
                        : "显示 OAuth Client Secret"
                    }
                    disabled={saving || !clientSecret}
                  >
                    {showSecret ? <EyeOff /> : <Eye />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </div>

            <div className="block space-y-2 text-sm">
              <label htmlFor="gsc-oauth-redirect-uri" className="font-medium">
                授权回调地址
              </label>
              <div className="flex gap-2">
                <Input
                  id="gsc-oauth-redirect-uri"
                  value={settings.oauthRedirectUri}
                  readOnly
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={copyRedirectUri}
                  aria-label="复制授权回调地址"
                  title="复制授权回调地址"
                  disabled={!settings.oauthRedirectUri}
                >
                  <Copy />
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>

      <div className="flex min-h-16 flex-wrap items-center gap-3 pt-6">
        <Button type="submit" disabled={loading || saving || !canSubmit}>
          {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
          {saving ? "保存中..." : "保存设置"}
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
