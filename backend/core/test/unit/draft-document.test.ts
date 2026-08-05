import { describe, expect, it } from "vitest";

import {
  draftDocumentToPlainText,
  plainTextToDraftDocument,
} from "../../src/modules/backlinks/domain/drafts/draft-document.js";
import {
  draftDocumentSchema,
} from "../../src/modules/backlinks/application/schemas/draft-document.schema.js";

describe("BL-AI-097 restricted Draft document", () => {
  it("accepts only the approved formatting surface and derives plain text", () => {
    const document = draftDocumentSchema.parse({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello ", marks: [{ type: "bold" }] },
            {
              type: "text",
              text: "GrowthOS",
              marks: [{
                type: "link",
                attrs: { href: "https://example.com/research" },
              }],
            },
          ],
        },
        {
          type: "bulletList",
          content: [{
            type: "listItem",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "Evidence-backed point" }],
            }],
          }],
        },
      ],
    });

    expect(draftDocumentToPlainText(document)).toBe(
      "Hello GrowthOS\n\n- Evidence-backed point",
    );
  });

  it.each([
    {
      name: "raw HTML node",
      document: {
        type: "doc",
        content: [{ type: "html", content: "<img onerror=alert(1)>" }],
      },
    },
    {
      name: "unsupported heading",
      document: {
        type: "doc",
        content: [{ type: "heading", attrs: { level: 1 } }],
      },
    },
    {
      name: "script URL",
      document: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [{
            type: "text",
            text: "unsafe",
            marks: [{
              type: "link",
              attrs: { href: "javascript:alert(1)" },
            }],
          }],
        }],
      },
    },
    {
      name: "unexpected link attributes",
      document: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [{
            type: "text",
            text: "unsafe",
            marks: [{
              type: "link",
              attrs: {
                href: "https://example.com",
                onclick: "alert(1)",
              },
            }],
          }],
        }],
      },
    },
  ])("rejects $name", ({ document }) => {
    expect(draftDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("converts historical plain text without treating it as HTML", () => {
    const document = plainTextToDraftDocument(
      "Hello <script>alert(1)</script>\nSecond line",
    );

    expect(document).toEqual({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "Hello <script>alert(1)</script>" },
          { type: "hardBreak" },
          { type: "text", text: "Second line" },
        ],
      }],
    });
    expect(draftDocumentToPlainText(document)).toBe(
      "Hello <script>alert(1)</script>\nSecond line",
    );
  });
});
