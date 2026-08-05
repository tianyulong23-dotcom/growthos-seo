import type {
  BacklinksDraftBlockNode,
  BacklinksResponse,
} from "@/api/generated/backlinks"

export type DraftStatus =
  BacklinksResponse<"backlinksGetDraftV1">["draft"]["status"]

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

export type DraftBlockNode = BacklinksDraftBlockNode

export type DraftDocument = {
  type: "doc"
  content: DraftBlockNode[]
}

export type DraftVersionSnapshot = NonNullable<
  BacklinksResponse<"backlinksGetDraftV1">["draft"]["currentVersion"]
>

export type DraftSnapshot = BacklinksResponse<"backlinksGetDraftV1">["draft"]

export type OpportunityContact =
  BacklinksResponse<"backlinksListOpportunityContactsV1">["items"][number]

export type BacklinksMeta = {
  organizationId: string
  workspaceId: string
  websiteProjectId: string
  requestId: string
  schemaVersion: "backlinks.v1"
  generatedAt: string
}

export type DraftMutationResult =
  BacklinksResponse<"backlinksSaveDraftVersionV1">

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
  "INITIAL_OUTREACH" | "FOLLOW_UP" | "NEGOTIATION_REPLY"

export type SendIntentResult =
  BacklinksResponse<"backlinksCreateSendIntentV1">

export type SendIntentView =
  BacklinksResponse<"backlinksGetSendIntentV1">["sendIntent"]
