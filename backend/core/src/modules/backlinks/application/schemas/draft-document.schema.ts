import { z } from "zod";

import type {
  DraftBlockNode,
  DraftDocument,
  DraftHardBreakNode,
  DraftListItemNode,
  DraftParagraphNode,
  DraftTextMark,
  DraftTextNode,
} from "../../domain/drafts/draft-document.js";

const safeHrefSchema = z.string().trim().min(1).max(2_048).refine((value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, "Draft links must use an absolute HTTP or HTTPS URL.");

const markSchema: z.ZodType<DraftTextMark> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }).strict(),
  z.object({ type: z.literal("italic") }).strict(),
  z.object({
    type: z.literal("link"),
    attrs: z.object({ href: safeHrefSchema }).strict(),
  }).strict(),
]);

const textNodeSchema: z.ZodType<DraftTextNode> = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(50_000),
  marks: z.array(markSchema).max(3).superRefine((marks, context) => {
    const types = marks.map((mark) => mark.type);
    if (new Set(types).size !== types.length) {
      context.addIssue({
        code: "custom",
        message: "Draft text marks must not be duplicated.",
      });
    }
  }).optional(),
}).strict();

const hardBreakNodeSchema: z.ZodType<DraftHardBreakNode> = z.object({
  type: z.literal("hardBreak"),
}).strict();

const paragraphNodeSchema: z.ZodType<DraftParagraphNode> = z.object({
  type: z.literal("paragraph"),
  content: z.array(z.union([textNodeSchema, hardBreakNodeSchema]))
    .max(10_000)
    .optional(),
}).strict();

const blockNodeSchema: z.ZodType<DraftBlockNode> = z.lazy(() =>
  z.union([
    paragraphNodeSchema,
    z.object({
      type: z.literal("bulletList"),
      content: z.array(listItemNodeSchema).min(1).max(1_000),
    }).strict(),
    z.object({
      type: z.literal("orderedList"),
      attrs: z.object({
        start: z.number().int().min(1).max(1_000_000),
      }).strict().optional(),
      content: z.array(listItemNodeSchema).min(1).max(1_000),
    }).strict(),
  ])
);

const listItemNodeSchema: z.ZodType<DraftListItemNode> = z.lazy(() =>
  z.object({
    type: z.literal("listItem"),
    content: z.array(blockNodeSchema).min(1).max(1_000),
  }).strict().superRefine((value, context) => {
    if (value.content[0]?.type !== "paragraph") {
      context.addIssue({
        code: "custom",
        path: ["content", 0],
        message: "A Draft list item must start with a paragraph.",
      });
    }
  })
);

z.globalRegistry.add(blockNodeSchema, { id: "BacklinksDraftBlockNode" });

function inspectDocument(
  document: DraftDocument,
): Readonly<{ characters: number; nodes: number; depth: number }> {
  let characters = 0;
  let nodes = 1;
  let depth = 1;

  const visit = (node: DraftBlockNode, currentDepth: number): void => {
    nodes += 1;
    depth = Math.max(depth, currentDepth);
    if (node.type === "paragraph") {
      for (const inline of node.content ?? []) {
        nodes += 1;
        if (inline.type === "text") characters += inline.text.length;
      }
      return;
    }
    for (const item of node.content) {
      nodes += 1;
      for (const child of item.content) {
        visit(child, currentDepth + 2);
      }
    }
  };

  for (const block of document.content) visit(block, 2);
  return { characters, nodes, depth };
}

export const draftDocumentSchema: z.ZodType<DraftDocument> = z.object({
  type: z.literal("doc"),
  content: z.array(blockNodeSchema).min(1).max(10_000),
}).strict().superRefine((document, context) => {
  const limits = inspectDocument(document);
  if (limits.characters < 1 || limits.characters > 50_000) {
    context.addIssue({
      code: "custom",
      message: "Draft document text must contain between 1 and 50000 characters.",
    });
  }
  if (limits.nodes > 20_000) {
    context.addIssue({
      code: "custom",
      message: "Draft document contains too many nodes.",
    });
  }
  if (limits.depth > 12) {
    context.addIssue({
      code: "custom",
      message: "Draft document nesting is too deep.",
    });
  }
});
