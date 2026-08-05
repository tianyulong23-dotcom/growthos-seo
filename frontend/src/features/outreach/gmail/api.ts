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
  websiteProjectKey: string,
  code: string,
  state: string,
  signal?: AbortSignal
) {
  return requestBacklinks(
    "backlinksCompleteGmailConnectionV1",
    {
      path: { websiteProjectKey },
      query: { code, state },
    },
    { signal }
  )
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
