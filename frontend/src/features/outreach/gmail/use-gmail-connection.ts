import * as React from "react"

import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import {
  disconnectGmailConnection,
  getGmailConnectionStatus,
  startGmailConnection,
} from "@/features/outreach/gmail/api"
import type {
  GmailConnectionView,
  GmailDisconnectResponse,
} from "@/features/outreach/gmail/types"

type GmailConnectionLoadStatus = "idle" | "loading" | "ready" | "error"

const oauthCallbackErrorParam = "gmailOAuth"
const invalidOAuthAttempt = "invalid_or_expired"
const invalidOAuthAttemptMessage =
  "Gmail 授权已过期或失效，请重新连接并在 10 分钟内完成 Google 同意。"

function readOAuthCallbackError(): string | null {
  if (typeof window === "undefined") return null
  const url = new URL(window.location.href)
  return url.searchParams.get(oauthCallbackErrorParam) === invalidOAuthAttempt
    ? invalidOAuthAttemptMessage
    : null
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
  const [errorMessage, setErrorMessage] = React.useState<string | null>(
    callbackError
  )
  const [busyAction, setBusyAction] = React.useState<
    "connect" | "disconnect" | null
  >(null)
  const [lastDisconnect, setLastDisconnect] = React.useState<
    GmailDisconnectResponse["revocationStatus"] | null
  >(null)
  const [loadedProjectKey, setLoadedProjectKey] = React.useState<string | null>(
    null
  )

  const currentProjectLoaded = loadedProjectKey === websiteProjectKey
  const visibleConnection = currentProjectLoaded ? connection : null
  const visibleStatus = enabled && !currentProjectLoaded ? "loading" : status

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
      setConnection(response.connection)
      setLoadedProjectKey(websiteProjectKey)
      setStatus("ready")
    } catch {
      setConnection(null)
      setLoadedProjectKey(websiteProjectKey)
      setStatus("error")
      setErrorMessage("无法读取 Gmail 连接状态；界面不会推断为已连接。")
    }
  }, [enabled, websiteProjectKey])

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
          setConnection(response.connection)
          setLoadedProjectKey(websiteProjectKey)
          setErrorMessage(callbackError)
          setStatus("ready")
        },
        () => {
          if (cancelled) return
          setConnection(null)
          setLoadedProjectKey(websiteProjectKey)
          setErrorMessage("无法读取 Gmail 连接状态；界面不会推断为已连接。")
          setStatus("error")
        }
      )

    return () => {
      cancelled = true
    }
  }, [callbackError, enabled, websiteProjectKey])

  const connect = React.useCallback(async () => {
    setBusyAction("connect")
    setErrorMessage(null)
    try {
      const response = await startGmailConnection(
        websiteProjectKey,
        window.location.pathname
      )
      window.location.assign(response.authorizationUrl)
    } catch {
      setErrorMessage(
        "未能启动 Gmail 授权。真实 Provider 默认关闭时会安全失败。"
      )
      setBusyAction(null)
    }
  }, [websiteProjectKey])

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
      setConnection(response.connection)
      setLastDisconnect(response.revocationStatus)
      setStatus("ready")
    } catch {
      setErrorMessage("断开请求未完成，发送保持暂停；请刷新后重试。")
    } finally {
      setBusyAction(null)
    }
  }, [visibleConnection, websiteProjectKey])

  return {
    status: visibleStatus,
    connection: visibleConnection,
    errorMessage,
    busyAction,
    lastDisconnect,
    refresh,
    connect,
    disconnect,
  }
}

export type GmailConnectionController = ReturnType<typeof useGmailConnection>
