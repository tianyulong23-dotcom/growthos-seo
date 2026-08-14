import * as React from "react"
import { KeyRound, LoaderCircle, RefreshCw, ShieldAlert } from "lucide-react"

import type { ArticleLock } from "@/api/articles"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import type { ArticleEditLockStatus } from "@/features/content/use-article-edit-lock"

function dateTimeLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN")
}

export function ArticleEditLockStatusBar({
  status,
  lock,
  error,
  canForceRelease,
  onAcquire,
  onForceRelease,
}: {
  status: ArticleEditLockStatus
  lock: ArticleLock | null
  error: string
  canForceRelease: boolean
  onAcquire: () => Promise<boolean>
  onForceRelease: (reason: string) => Promise<boolean>
}) {
  const [forceOpen, setForceOpen] = React.useState(false)
  const [reason, setReason] = React.useState("")
  const [working, setWorking] = React.useState(false)
  const [actionError, setActionError] = React.useState("")

  if (status === "idle" || status === "held") return null

  async function forceRelease() {
    if (!reason.trim()) {
      setActionError("管理解锁必须填写原因。")
      return
    }
    setWorking(true)
    setActionError("")
    try {
      const acquired = await onForceRelease(reason)
      if (acquired) {
        setForceOpen(false)
        setReason("")
      }
    } catch (requestError) {
      setActionError(
        requestError instanceof Error ? requestError.message : "管理解锁失败"
      )
    } finally {
      setWorking(false)
    }
  }

  return (
    <>
      <div
        className="mb-4 border-y border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
        role="status"
      >
        <div className="flex flex-wrap items-center gap-3">
          {status === "acquiring" ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <ShieldAlert className="size-4" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {status === "acquiring"
                ? "正在获取编辑锁"
                : status === "lost"
                  ? "编辑锁已丢失，当前为只读模式"
                  : "文章正在被其他成员编辑"}
            </p>
            <p className="mt-1 text-xs opacity-80">
              {error || "获取编辑锁后才能修改和保存正文。"}
              {lock && status === "blocked"
                ? ` 持有人：${lock.owner_id}，到期：${dateTimeLabel(lock.expires_at)}。`
                : ""}
            </p>
          </div>
          {status !== "acquiring" && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onAcquire()}
              >
                <RefreshCw /> 重新获取
              </Button>
              {canForceRelease && lock && status === "blocked" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setForceOpen(true)}
                >
                  <KeyRound /> 管理解锁
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <Dialog open={forceOpen} onOpenChange={setForceOpen}>
        <DialogContent className="rounded-md sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>管理强制释放编辑锁</DialogTitle>
            <DialogDescription>
              该操作会中断当前持有人的编辑会话并写入审计记录。释放后，本窗口会立即尝试获取新锁。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={4}
            placeholder="填写业务原因，例如：原编辑会话已异常退出"
            aria-label="管理解锁原因"
          />
          {actionError && (
            <p className="text-sm text-destructive" role="alert">
              {actionError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={working}
              onClick={() => setForceOpen(false)}
            >
              取消
            </Button>
            <Button disabled={working} onClick={() => void forceRelease()}>
              {working ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
              强制释放并获取
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
