import { describe, expect, it } from "vitest"

import {
  sanitizeDraftRecipientDocument,
  sanitizeDraftRecipientText,
} from "@/features/outreach/drafts/draft-document"

describe("draft recipient content sanitation", () => {
  it("removes internal evidence markers without removing normal email text", () => {
    expect(
      sanitizeDraftRecipientText(
        "Partnership idea [contact:confirmed, profile:current]"
      )
    ).toEqual({
      value: "Partnership idea",
      removedInternalMetadata: true,
    })
    expect(
      sanitizeDraftRecipientText("Contact: editorial@example.com")
    ).toEqual({
      value: "Contact: editorial@example.com",
      removedInternalMetadata: false,
    })
  })

  it("cleans historical markers from paragraphs and list items", () => {
    const result = sanitizeDraftRecipientDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Audience fit. [profile:current, opportunity:current]",
            },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "[promotion-target:current] Useful detail",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    expect(result.removedInternalMetadata).toBe(true)
    expect(result.document).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Audience fit." }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: " Useful detail" }],
                },
              ],
            },
          ],
        },
      ],
    })
  })
})
