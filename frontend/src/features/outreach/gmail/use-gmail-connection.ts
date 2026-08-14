import * as React from "react"

import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import {
  disconnectGmailConnection,
  getGmailConnectionStatus,
  selectGmailConnection,
  startGmailConnection,
} from "@/features/outreach/gmail/api"
import type {
  GmailConnectionView,
  GmailDisconnectResponse,
  GmailStatusResponse,
} from "@/features/outreach/gmail/types"

type GmailConnectionLoadStatus = "idle" | "loading" | "ready" | "error"

const oauthCallbackErrorParam = "gmailOAuth"
const invalidOAuthAttempt = "invalid_or_expired"
const invalidOAuthAttemptMessage =
  "Gmail 授权已过期或失效，请重新连接并在 10 分钟内完成 Google 同意。"
const deniedOAuthAttempt = "access_denied"
const deniedOAuthAttemptMessage = "已取消 Gmail 授权，未保存任何连接。"

function readOAuthCallbackError(): string | null {
  if (typeof window === "undefined") return null
  const url = new URL(window.location.href)
  const callbackError = url.searchParams.get(oauthCallbackErrorParam)
  if (callbackError === invalidOAuthAttempt) return invalidOAuthAttemptMessage
  if (callbackError === deniedOAuthAttempt) return deniedOAuthAttemptMessage
  return null
}

function clearOAuthCallbackError(): void {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  if (!url.searchParams.has(oauthCallbackErrorParam)) return
  url.searchParams.delete(oauthCallbackErrorParam)
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  )
}

export function useGmailConnection(
  websiteProjectKey: string,
  enabled: boolean
) {
  const callbackError = React.useMemo(() => readOAuthCallbackError(), [])
  const [status, setStatus] = React.useState<GmailConnectionLoadStatus>("idle")
  const [connection, setConnection] =
    React.useState<GmailConnectionView | null>(null)
  const [accounts, setAccounts] = React.useState<GmailConnectionView[]>([])
  const [errorMessage, setErrorMessage] = React.useState<string | null>(
    callbackError
  )
  const [busyAction, setBusyAction] = React.useState<
    "connect" | "disconnect" | "select" | null
  >(null)
  const [lastDisconnect, setLastDisconnect] = React.useState<
    GmailDisconnectResponse["revocationStatus"] | null
  >(null)
  const [loadedProjectKey, setLoadedProjectKey] = React.useState<string | null>(
    null
  )

  const currentProjectLoaded = loadedProjectKey === websiteProjectKey
  const visibleConnection = currentProjectLoaded ? connection : null
  const visibleAccounts = currentProjectLoaded ? accounts : []
  const visibleStatus = enabled && !currentProjectLoaded ? "loading" : status

  const applyStatusResponse = React.useCallback(
    (response: GmailStatusResponse) => {
      setConnection(response.connection)
      setAccounts(response.accounts)
      setLoadedProjectKey(websiteProjectKey)
      setStatus("ready")
    },
    [websiteProjectKey]
  )

  React.useEffect(() => {
    if (callbackError !== null) {
      clearOAuthCallbackError()
    }
  }, [callbackError])

  const refresh = React.useCallback(async () => {
    if (!enabled) return
    const queryKey = createProjectQueryKey(
      websiteProjectKey,
      "gmail-connection-status"
    )
    backlinksProjectQueries.invalidate(queryKey)
    setStatus("loading")
    setErrorMessage(null)
    try {
      const response = await backlinksProjectQueries.fetch(queryKey, (signal) =>
        getGmailConnectionStatus(websiteProjectKey, signal)
      )
      applyStatusResponse(response)
    } catch {
      setConnection(null)
      setAccounts([])
      setLoadedProjectKey(websiteProjectKey)
      setStatus("error")
      setErrorMessage("无法读取 Gmail 连接状态；界面不会推断为已连接。")
    }
  }, [applyStatusResponse, enabled, websiteProjectKey])

  React.useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const queryKey = createProjectQueryKey(
      websiteProjectKey,
      "gmail-connection-status"
    )

    void backlinksProjectQueries
      .fetch(queryKey, (signal) =>
        getGmailConnectionStatus(websiteProjectKey, signal)
      )
      .then(
        (response) => {
          if (cancelled) return
          applyStatusResponse(response)
          setErrorMessage(callbackError)
        },
        () => {
          if (cancelled) return
          setConnection(null)
          setAccounts([])
          setLoadedProjectKey(websiteProjectKey)
          setErrorMessage("无法读取 Gmail 连接状态；界面不会推断为已连接。")
          setStatus("error")
        }
      )

    return () => {
      cancelled = true
    }
  }, [applyStatusResponse, callbackError, enabled, websiteProjectKey])

  const connect = React.useCallback(async () => {
    setBusyAction("connect")
    setErrorMessage(null)
    try {
      const response = await startGmailConnection(
        websiteProjectKey,
        `/projects/${websiteProjectKey}/backlinks/email`
      )
      window.location.assign(response.authorizationUrl)
      window.setTimeout(() => {
        setBusyAction((current) => (current === "connect" ? null : current))
      }, 15_000)
    } catch {
      setErrorMessage(
        "未能启动 Gmail 授权。真实 Provider 默认关闭时会安全失败。"
      )
      setBusyAction(null)
    }
  }, [websiteProjectKey])

  const select = React.useCallback(
    async (connectionId: string) => {
      if (visibleConnection?.connectionId === connectionId) return
      setBusyAction("select")
      setErrorMessage(null)
      try {
        const response = await selectGmailConnection(
          websiteProjectKey,
          connectionId
        )
        backlinksProjectQueries.invalidate(
          createProjectQueryKey(websiteProjectKey, "gmail-connection-status")
        )
        applyStatusResponse(response)
        setLastDisconnect(null)
      } catch {
        setErrorMessage("未能为当前项目选择该 Gmail 账号，请刷新后重试。")
      } finally {
        setBusyAction(null)
      }
    },
    [applyStatusResponse, visibleConnection?.connectionId, websiteProjectKey]
  )

  const disconnect = React.useCallback(async () => {
    if (visibleConnection === null) return
    setBusyAction("disconnect")
    setErrorMessage(null)
    try {
      const response = await disconnectGmailConnection(
        websiteProjectKey,
        visibleConnection.connectionId,
        visibleConnection.version
      )
      backlinksProjectQueries.invalidate(
        createProjectQueryKey(websiteProjectKey, "gmail-connection-status")
      )
      setLastDisconnect(response.revocationStatus)
      await refresh()
    } catch {
      setErrorMessage("断开请求未完成，发送保持暂停；请刷新后重试。")
    } finally {
      setBusyAction(null)
    }
  }, [refresh, visibleConnection, websiteProjectKey])

  return {
    status: visibleStatus,
    connection: visibleConnection,
    accounts: visibleAccounts,
    errorMessage,
    busyAction,
    lastDisconnect,
    refresh,
    connect,
    select,
    disconnect,
  }
}

export type GmailConnectionController = ReturnType<typeof useGmailConnection>
