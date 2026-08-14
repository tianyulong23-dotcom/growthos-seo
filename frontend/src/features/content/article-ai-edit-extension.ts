import { Extension, type Editor } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

export const articleAIEditDecorationKey = new PluginKey<DecorationSet>(
  "articleAIEditDecoration"
)

export type ArticleAIEditDecoration = {
  from: number
  to: number
  stale?: boolean
} | null

export function setArticleAIEditDecoration(
  editor: Editor,
  decoration: ArticleAIEditDecoration
) {
  editor.view.dispatch(
    editor.state.tr.setMeta(articleAIEditDecorationKey, decoration)
  )
}

export const ArticleAIEditExtension = Extension.create({
  name: "articleAIEdit",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: articleAIEditDecorationKey,
        state: {
          init: () => DecorationSet.empty,
          apply(transaction, current) {
            const requested = transaction.getMeta(
              articleAIEditDecorationKey
            ) as ArticleAIEditDecoration | undefined
            if (requested !== undefined) {
              if (!requested || requested.from >= requested.to) {
                return DecorationSet.empty
              }
              return DecorationSet.create(transaction.doc, [
                Decoration.inline(requested.from, requested.to, {
                  class: requested.stale
                    ? "article-ai-selection article-ai-selection-stale"
                    : "article-ai-selection",
                  "data-ai-edit-selection": requested.stale
                    ? "stale"
                    : "active",
                }),
              ])
            }
            return transaction.docChanged
              ? current.map(transaction.mapping, transaction.doc)
              : current
          },
        },
        props: {
          decorations: (state) => articleAIEditDecorationKey.getState(state),
        },
      }),
    ]
  },
})
