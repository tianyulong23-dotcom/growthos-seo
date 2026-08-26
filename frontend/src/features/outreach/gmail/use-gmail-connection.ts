import * as React from "react"

import { ApiError } from "@/api/client"
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
  GmailReadinessProjection,
  GmailStatusResponse,
} from "@/features/outreach/gmail/types"

type GmailConnectionLoadStatus = "idle" | "loading" | "ready" | "error"

const oauthCallbackErrorParam = "gmailOAuth"
const invalidOAuthAttempt = "invalid_or_expired"
const invalidOAuthAttemptMessage =
  "Gmail 授权已过期或失效，请重新连接并在 10 分钟内完成 Google 同意。"
const deniedOAuthAttempt = "access_denied"
const deniedOAuthAttemptMessage = "已取消 Gmail 授权，未保存任何连接。"
const providerUnavailableOAuthAttempt = "provider_unavailable"
const providerUnavailableOAuthAttemptMessage =
  "Google 授权服务暂时不可用，连接未完成。请点击重新连接 Gmail；系统不会误标为已连接。"
const failedOAuthAttempt = "failed"
const failedOAuthAttemptMessage =
  "Gmail 连接未完成。请点击重新连接 Gmail；若问题持续，请提供页面中的请求编号。"

function readOAuthCallbackError(): string | null {
  if (typeof window === "undefined") return null
  const url = new URL(window.location.href)
  const callbackError = url.searchParams.get(oauthCallbackErrorParam)
  if (callbackError === invalidOAuthAttempt) return invalidOAuthAttemptMessage
  if (callbackError === deniedOAuthAttempt) return deniedOAuthAttemptMessage
  if (callbackError === providerUnavailableOAuthAttempt) {
    return providerUnavailableOAuthAttemptMessage
  }
  if (callbackError === failedOAuthAttempt) return failedOAuthAttemptMessage
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
  const [readiness, setReadiness] =
    React.useState<GmailReadinessProjection | null>(null)
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
  const activeProjectKeyRef = React.useRef(websiteProjectKey)
  activeProjectKeyRef.current = websiteProjectKey

  const currentProjectLoaded = loadedProjectKey === websiteProjectKey
  const visibleConnection = currentProjectLoaded ? connection : null
  const visibleAccounts = currentProjectLoaded ? accounts : []
  const visibleReadiness = currentProjectLoaded ? readiness : null
  const visibleStatus = enabled && !currentProjectLoaded ? "loading" : status

  const applyStatusResponse = React.useCallback(
    (projectKey: string, response: GmailStatusResponse) => {
      if (activeProjectKeyRef.current !== projectKey) return
      setConnection(response.connection)
      setAccounts(response.accounts)
      setReadiness(response.readiness)
      setLoadedProjectKey(projectKey)
      setStatus("ready")
    },
    []
  )

  React.useEffect(() => {
    if (callbackError !== null) {
      clearOAuthCallbackError()
    }
  }, [callbackError])

  const refresh = React.useCallback(async () => {
    if (!enabled) return
    const projectKey = websiteProjectKey
    const queryKey = createProjectQueryKey(
      projectKey,
      "gmail-connection-status"
    )
    backlinksProjectQueries.invalidate(queryKey)
    setStatus("loading")
    setErrorMessage(null)
    try {
      const response = await backlinksProjectQueries.fetch(queryKey, (signal) =>
        getGmailConnectionStatus(projectKey, signal)
      )
      applyStatusResponse(projectKey, response)
    } catch {
      if (activeProjectKeyRef.current !== projectKey) return
      setConnection(null)
      setAccounts([])
      setReadiness(null)
      setLoadedProjectKey(projectKey)
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
          applyStatusResponse(websiteProjectKey, response)
          setErrorMessage(callbackError)
        },
        () => {
          if (cancelled) return
          setConnection(null)
          setAccounts([])
          setReadiness(null)
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
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "OAUTH_ORIGIN_MISMATCH" &&
        error.canonicalFrontendOrigin !== null
      ) {
        const canonical = new URL(error.canonicalFrontendOrigin)
        if (canonical.origin !== window.location.origin) {
          window.location.assign(
            `${canonical.origin}${window.location.pathname}${window.location.search}${window.location.hash}`
          )
          return
        }
      }
      setErrorMessage(
        error instanceof ApiError && error.code === "OAUTH_ORIGIN_MISMATCH"
          ? "Gmail 授权地址配置不一致，系统未创建授权票据。请刷新后重试。"
          : "未能启动 Gmail 授权。请稍后重试；连接状态不会被误标为已连接。"
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
        const projectKey = websiteProjectKey
        const response = await selectGmailConnection(projectKey, connectionId)
        backlinksProjectQueries.invalidate(
          createProjectQueryKey(projectKey, "gmail-connection-status")
        )
        applyStatusResponse(projectKey, response)
        if (activeProjectKeyRef.current !== projectKey) return
        setLastDisconnect(null)
      } catch {
        if (activeProjectKeyRef.current !== websiteProjectKey) return
        setErrorMessage("未能为当前项目选择该 Gmail 账号，请刷新后重试。")
      } finally {
        if (activeProjectKeyRef.current === websiteProjectKey) {
          setBusyAction(null)
        }
      }
    },
    [applyStatusResponse, visibleConnection?.connectionId, websiteProjectKey]
  )

  const disconnect = React.useCallback(async () => {
    if (visibleConnection === null) return
    const projectKey = websiteProjectKey
    setBusyAction("disconnect")
    setErrorMessage(null)
    try {
      const response = await disconnectGmailConnection(
        projectKey,
        visibleConnection.connectionId,
        visibleConnection.version
      )
      backlinksProjectQueries.invalidate(
        createProjectQueryKey(projectKey, "gmail-connection-status")
      )
      if (activeProjectKeyRef.current !== projectKey) return
      setLastDisconnect(response.revocationStatus)
      await refresh()
    } catch {
      if (activeProjectKeyRef.current !== projectKey) return
      setErrorMessage("断开请求未完成，发送保持暂停；请刷新后重试。")
    } finally {
      if (activeProjectKeyRef.current === projectKey) {
        setBusyAction(null)
      }
    }
  }, [refresh, visibleConnection, websiteProjectKey])

  return {
    status: visibleStatus,
    connection: visibleConnection,
    accounts: visibleAccounts,
    readiness: visibleReadiness,
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
