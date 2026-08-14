import { FolderKanban, RefreshCw, TriangleAlert } from "lucide-react"
import { useNavigate, useRouteError } from "react-router"

import { Button } from "@/components/ui/button"

function isModuleLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /dynamically imported module|loading chunk|importing a module script/i.test(
    message
  )
}

export function RouteErrorPage() {
  const error = useRouteError()
  const navigate = useNavigate()
  const moduleLoadFailed = isModuleLoadError(error)

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground">
      <div className="w-full max-w-xl">
        <div className="mb-5 flex size-11 items-center justify-center rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <TriangleAlert aria-hidden="true" className="size-5" />
        </div>
        <h1 className="text-2xl font-semibold">页面暂时没有加载成功</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {moduleLoadFailed
            ? "前端服务刚才中断或正在恢复，页面文件没有加载完整。当前后台任务和已保存的数据不会因此丢失。"
            : "当前页面遇到了异常。已保存的数据不会因此丢失，请重新加载后继续。"}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => window.location.reload()}>
            <RefreshCw aria-hidden="true" data-icon="inline-start" />
            重新加载
          </Button>
          <Button variant="outline" onClick={() => navigate("/projects")}>
            <FolderKanban aria-hidden="true" data-icon="inline-start" />
            返回项目列表
          </Button>
        </div>
      </div>
    </main>
  )
}
