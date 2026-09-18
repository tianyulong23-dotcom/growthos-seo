import { useEffect, useState } from "react"
import { ChevronDown, FileText, RefreshCw } from "lucide-react"
import { Link } from "react-router"

import {
  requestBacklinks,
  type BacklinksResponse,
} from "@/api/generated/backlinks"
import { Button } from "@/components/ui/button"
import { getDraft } from "@/features/outreach/drafts/api"

type Item = BacklinksResponse<"backlinksListOpportunitiesV1">["items"][number]
type Draft = BacklinksResponse<"backlinksGetDraftV1">["draft"]

const statuses: Record<Draft["status"], string> = {
  generating: "生成中",
  draft: "未审批",
  approved: "已审批",
  rejected: "已拒绝",
  sent: "已发送",
}

export function DraftInbox({
  websiteProjectKey,
}: {
  websiteProjectKey: string
}) {
  // Remount on project changes so no previous project's draft can remain visible.
  return (
    <ProjectDraftInbox
      key={websiteProjectKey}
      websiteProjectKey={websiteProjectKey}
    />
  )
}

function ProjectDraftInbox({
  websiteProjectKey,
}: {
  websiteProjectKey: string
}) {
  const [items, setItems] = useState<Item[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [cursor, setCursor] = useState<string | undefined>()
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    void requestBacklinks(
      "backlinksListOpportunitiesV1",
      {
        path: { websiteProjectKey },
        query: { limit: 100, cursor },
      },
      { signal: controller.signal }
    )
      .then((page) => {
        if (controller.signal.aborted) return
        if (page.hasMore && (!page.nextCursor || page.nextCursor === cursor)) {
          throw new Error("Invalid opportunity cursor")
        }
        const drafts = page.items.filter(
          (item) =>
            item.draftId && item.primaryNextAction.kind !== "VIEW_MAIL_STATUS"
        )
        setItems((previous) => {
          const combined = cursor ? [...previous, ...drafts] : drafts
          return [
            ...new Map(combined.map((item) => [item.draftId, item])).values(),
          ]
        })
        setNextCursor(page.hasMore ? page.nextCursor : null)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [websiteProjectKey, cursor, revision])

  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    setDetailLoading(true)
    setDetailError(false)
    setDraft(null)
    void getDraft(websiteProjectKey, selected, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDraft(result.draft)
      })
      .catch(() => {
        if (!controller.signal.aborted) setDetailError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false)
      })
    return () => controller.abort()
  }, [websiteProjectKey, selected, revision])

  function refresh() {
    setItems([])
    setSelected(null)
    setDraft(null)
    setCursor(undefined)
    setNextCursor(null)
    setRevision((value) => value + 1)
  }

  const selectedItem = items.find((item) => item.draftId === selected)

  return (
    <section aria-label="项目草稿" className="mail-drafts min-w-0">
      <div className="mail-view-toolbar flex items-center justify-between gap-3 border-b py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <FileText className="size-4" />
          草稿
          <span className="font-normal text-muted-foreground">
            {items.length}
            {nextCursor ? "+" : ""}
          </span>
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新草稿"
          title="刷新草稿"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <div className="mail-split-view grid min-h-80 min-w-0 md:grid-cols-[minmax(220px,320px)_minmax(0,1fr)]">
        <div className="mail-message-list min-w-0 border-b md:border-r md:border-b-0">
          {error ? (
            <div role="alert" className="p-4 text-sm">
              草稿列表加载失败
              <Button
                variant="link"
                onClick={() => setRevision((value) => value + 1)}
              >
                重试
              </Button>
            </div>
          ) : null}
          {loading ? (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              正在读取草稿…
            </p>
          ) : null}
          {!loading && !error && items.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {nextCursor ? "已读取的机会中暂无草稿" : "暂无待处理草稿"}
            </p>
          ) : null}
          <ul aria-label="草稿列表">
            {items.map((item) => (
              <li key={item.draftId}>
                <button
                  type="button"
                  aria-pressed={selected === item.draftId}
                  className={`mail-message-item w-full min-w-0 border-b px-4 py-3 text-left text-sm hover:bg-muted/50 ${selected === item.draftId ? "bg-muted" : ""}`}
                  onClick={() => {
                    if (selected === item.draftId) return
                    setDraft(null)
                    setDetailError(false)
                    setDetailLoading(true)
                    setSelected(item.draftId)
                  }}
                >
                  <span className="block font-medium break-all">
                    {item.targetHostAscii}
                  </span>
                  <span className="mt-1 block text-xs break-all text-muted-foreground">
                    {item.contactEmail ?? "联系人待核验"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {nextCursor && !error ? (
            <Button
              className="my-3 w-full"
              variant="ghost"
              disabled={loading}
              onClick={() => setCursor(nextCursor)}
            >
              <ChevronDown className="size-4" />
              加载更多
            </Button>
          ) : null}
        </div>
        <div className="mail-reader min-w-0 p-4 md:p-6" aria-label="草稿预览">
          {!selected ? (
            <p className="mail-reader-empty py-12 text-center text-sm text-muted-foreground">
              <FileText className="size-8" aria-hidden="true" />
              选择一封草稿查看正文
            </p>
          ) : detailLoading ? (
            <p role="status" className="text-sm">
              正在读取正文…
            </p>
          ) : detailError ? (
            <div role="alert" className="text-sm">
              草稿正文加载失败
              <Button
                variant="link"
                onClick={() => setRevision((value) => value + 1)}
              >
                重试
              </Button>
            </div>
          ) : draft ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {statuses[draft.status]}
                </span>
                <Link
                  className="text-sm font-medium text-primary hover:underline"
                  to={`/projects/${websiteProjectKey}/backlinks/drafts/${draft.id}`}
                >
                  打开草稿
                </Link>
              </div>
              <h3 className="text-base font-semibold break-words">
                {draft.currentVersion?.subjectText || "暂无主题"}
              </h3>
              <p className="text-xs break-all text-muted-foreground">
                网站：{selectedItem?.targetHostAscii}
              </p>
              {draft.freshness.regenerateRequired ? (
                <p role="status" className="text-sm text-amber-700">
                  资料已变化，需要重新核验或生成。
                </p>
              ) : null}
              <div className="border-t pt-4 text-sm leading-7 break-words whitespace-pre-wrap">
                {draft.currentVersion?.bodyText || "尚无可用正文"}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
