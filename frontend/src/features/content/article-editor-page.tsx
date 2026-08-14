import * as React from "react"
import { Navigate, useBlocker, useNavigate, useParams } from "react-router"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ArticleWorkspace } from "@/features/content/article-workspace"

const LEAVE_FLUSH_TIMEOUT_MS = 1_500

export function ArticleEditorPage() {
  const navigate = useNavigate()
  const { projectId, articleId } = useParams()
  const [protection, setProtection] = React.useState<{
    dirty: boolean
    flush: () => Promise<boolean>
    protectLocally: () => boolean
  }>({
    dirty: false,
    flush: async () => true,
    protectLocally: () => true,
  })
  const [leaving, setLeaving] = React.useState(false)
  const [leaveError, setLeaveError] = React.useState("")
  const blocker = useBlocker(protection.dirty)

  const leave = React.useCallback(async () => {
    if (leaving) return
    setLeaving(true)
    setLeaveError("")
    try {
      const savedToServer = await Promise.race([
        protection.flush(),
        new Promise<boolean>((resolve) =>
          window.setTimeout(() => resolve(false), LEAVE_FLUSH_TIMEOUT_MS)
        ),
      ])
      if (savedToServer || protection.protectLocally()) {
        blocker.proceed?.()
        return
      }
      setLeaveError("草稿保存失败。为避免丢失修改，当前仍停留在编辑器。")
    } finally {
      setLeaving(false)
    }
  }, [blocker, leaving, protection])

  if (!projectId || !articleId) {
    return <Navigate to="/projects" replace />
  }

  return (
    <TooltipProvider>
      <ArticleWorkspace
        projectId={projectId}
        articleId={articleId}
        onBack={() => navigate(`/projects/${projectId}/content/library`)}
        onProtectionChange={setProtection}
      />
      <Dialog open={blocker.state === "blocked"}>
        <DialogContent showCloseButton={false} className="rounded-md">
          <DialogHeader>
            <DialogTitle>有未保存的修改</DialogTitle>
            <DialogDescription>
              保存草稿后再离开，避免本次修改丢失。
            </DialogDescription>
          </DialogHeader>
          {leaveError && (
            <p className="text-sm text-destructive" role="alert">
              {leaveError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={leaving}
              onClick={() => {
                setLeaveError("")
                blocker.reset?.()
              }}
            >
              继续编辑
            </Button>
            <Button disabled={leaving} onClick={() => void leave()}>
              {leaving ? "正在保存草稿" : "保存草稿并离开"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
