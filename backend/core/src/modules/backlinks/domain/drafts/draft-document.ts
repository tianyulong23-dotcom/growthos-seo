type DraftBoldMark = Readonly<{ type: "bold" }>;
type DraftItalicMark = Readonly<{ type: "italic" }>;
type DraftLinkMark = Readonly<{
  type: "link";
  attrs: Readonly<{ href: string }>;
}>;
export type DraftTextMark = DraftBoldMark | DraftItalicMark | DraftLinkMark;

export type DraftTextNode = Readonly<{
  type: "text";
  text: string;
  marks?: readonly DraftTextMark[] | undefined;
}>;
export type DraftHardBreakNode = Readonly<{ type: "hardBreak" }>;
export type DraftParagraphNode = Readonly<{
  type: "paragraph";
  content?: readonly (DraftTextNode | DraftHardBreakNode)[] | undefined;
}>;
export type DraftListItemNode = Readonly<{
  type: "listItem";
  content: readonly DraftBlockNode[];
}>;
export type DraftBulletListNode = Readonly<{
  type: "bulletList";
  content: readonly DraftListItemNode[];
}>;
export type DraftOrderedListNode = Readonly<{
  type: "orderedList";
  attrs?: Readonly<{ start: number }> | undefined;
  content: readonly DraftListItemNode[];
}>;
export type DraftBlockNode =
  | DraftParagraphNode
  | DraftBulletListNode
  | DraftOrderedListNode;
export type DraftDocument = Readonly<{
  type: "doc";
  content: readonly DraftBlockNode[];
}>;

const paragraphText = (paragraph: DraftParagraphNode): string =>
  (paragraph.content ?? []).map((node) =>
    node.type === "hardBreak" ? "\n" : node.text
  ).join("");

function renderList(
  list: DraftBulletListNode | DraftOrderedListNode,
  depth: number,
): string {
  const start = list.type === "orderedList" ? list.attrs?.start ?? 1 : 1;
  return list.content.map((item, index) => {
    const prefix = list.type === "orderedList" ? `${start + index}. ` : "- ";
    const parts = item.content.map((block) =>
      block.type === "paragraph"
        ? paragraphText(block)
        : renderList(block, depth + 1)
    );
    const [first = "", ...rest] = parts;
    const indent = "  ".repeat(depth);
    return `${indent}${prefix}${first}${
      rest.length === 0 ? "" : `\n${rest.join("\n")}`
    }`;
  }).join("\n");
}

export function draftDocumentToPlainText(document: DraftDocument): string {
  return document.content.map((block) =>
    block.type === "paragraph" ? paragraphText(block) : renderList(block, 0)
  ).join("\n\n");
}

export function plainTextToDraftDocument(bodyText: string): DraftDocument {
  const paragraphs = bodyText.split(/\n{2,}/u).map((paragraph) => {
    const content: (DraftTextNode | DraftHardBreakNode)[] = [];
    paragraph.split("\n").forEach((line, index) => {
      if (index > 0) content.push({ type: "hardBreak" });
      if (line.length > 0) content.push({ type: "text", text: line });
    });
    return {
      type: "paragraph" as const,
      ...(content.length === 0 ? {} : { content }),
    };
  });
  return {
    type: "doc",
    content: paragraphs,
  };
}
