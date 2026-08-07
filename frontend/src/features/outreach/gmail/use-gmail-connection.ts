import * as React from "react"

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

export function useGmailConnection(
  websiteProjectKey: string,
  enabled: boolean,
  returnPath?: string
) {
  const [status, setStatus] = React.useState<GmailConnectionLoadStatus>("idle")
  const [connection, setConnection] =
    React.useState<GmailConnectionView | null>(null)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
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

  const refresh = React.useCallback(async () => {
    if (!enabled) return
    setStatus("loading")
    setErrorMessage(null)
    try {
      const response = await getGmailConnectionStatus(websiteProjectKey)
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

    void getGmailConnectionStatus(websiteProjectKey).then(
      (response) => {
        if (cancelled) return
        setConnection(response.connection)
        setLoadedProjectKey(websiteProjectKey)
        setErrorMessage(null)
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
  }, [enabled, websiteProjectKey])

  const connect = React.useCallback(async () => {
    setBusyAction("connect")
    setErrorMessage(null)
    try {
      const response = await startGmailConnection(
        websiteProjectKey,
        returnPath ?? window.location.pathname
      )
      window.location.assign(response.authorizationUrl)
    } catch {
      setErrorMessage(
        "未能启动 Gmail 授权。真实 Provider 默认关闭时会安全失败。"
      )
      setBusyAction(null)
    }
  }, [returnPath, websiteProjectKey])

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
