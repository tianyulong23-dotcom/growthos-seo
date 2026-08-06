import { requestBacklinks } from "@/api/generated/backlinks"

export function getGmailConnectionStatus(
  websiteProjectKey: string,
  signal?: AbortSignal
) {
  return requestBacklinks(
    "backlinksGetGmailConnectionStatusV1",
    {
      path: { websiteProjectKey },
    },
    { signal }
  )
}

export function startGmailConnection(
  websiteProjectKey: string,
  returnPath: string
) {
  return requestBacklinks("backlinksConnectGmailV1", {
    path: { websiteProjectKey },
    body: { returnPath },
  })
}

export function completeGmailConnection(
  code: string,
  state: string,
  signal?: AbortSignal
) {
  return requestBacklinks(
    "backlinksCompleteGmailConnectionV1",
    {
      query: { code, state },
    },
    { signal }
  )
}

export function selectGmailConnection(
  websiteProjectKey: string,
  connectionId: string
) {
  return requestBacklinks("backlinksSelectGmailConnectionV1", {
    path: { websiteProjectKey },
    body: { connectionId },
  })
}

export function disconnectGmailConnection(
  websiteProjectKey: string,
  connectionId: string,
  expectedVersion: number
) {
  return requestBacklinks("backlinksDisconnectGmailV1", {
    path: { websiteProjectKey, connectionId },
    body: { expectedVersion },
  })
}
