export type DraftStatus =
  "generating" | "draft" | "approved" | "rejected" | "sent"

export type DraftTextMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "link"; attrs: { href: string } }

export type DraftTextNode = {
  type: "text"
  text: string
  marks?: DraftTextMark[]
}

export type DraftHardBreakNode = {
  type: "hardBreak"
}

export type DraftParagraphNode = {
  type: "paragraph"
  content?: Array<DraftTextNode | DraftHardBreakNode>
}

export type DraftListItemNode = {
  type: "listItem"
  content: DraftBlockNode[]
}

export type DraftBulletListNode = {
  type: "bulletList"
  content: DraftListItemNode[]
}

export type DraftOrderedListNode = {
  type: "orderedList"
  attrs?: { start: number }
  content: DraftListItemNode[]
}

export type DraftBlockNode =
  DraftParagraphNode | DraftBulletListNode | DraftOrderedListNode

export type DraftDocument = {
  type: "doc"
  content: DraftBlockNode[]
}

export type DraftVersionSnapshot = {
  id: string
  versionNo: number
  subjectText: string
  bodyText: string
  bodyDocument: DraftDocument
  source: "MODEL" | "MANUAL" | "RESTORED"
  createdAt: string
}

export type DraftSnapshot = {
  id: string
  opportunityId: string
  status: DraftStatus
  draftVersion: number
  approvedVersionId: string | null
  currentVersion: DraftVersionSnapshot | null
}

export type BacklinksMeta = {
  organizationId: string
  workspaceId: string
  websiteProjectId: string
  requestId: string
  schemaVersion: "backlinks.v1"
  generatedAt: string
}

export type DraftMutationResult = {
  draftId: string
  versionId: string
  draftVersion: number
  status: "draft" | "approved"
  meta: BacklinksMeta
}

export type ContactCandidate = {
  id: string
  normalizedEmail: string
  observedRole: string | null
  inferredPurpose:
    | "press"
    | "editorial"
    | "partnerships"
    | "advertising"
    | "support"
    | "general"
    | "unknown"
  confidence: number
  guessed: boolean
  status: "candidate"
  version: number
}

export type SendIntentMessagePurpose =
  | "INITIAL_OUTREACH"
  | "FOLLOW_UP"
  | "NEGOTIATION_REPLY"

export type SendIntentResult = {
  sendIntentId: string
  draftId: string
  approvedDraftVersionId: string
  status: "READY"
  version: 1
  requestedSendAt: string
  meta: BacklinksMeta
}
