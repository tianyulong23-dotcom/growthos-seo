import * as React from "react"
import { Globe2 } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Project } from "@/features/projects/types"

type ProjectFaviconProps = {
  project: Project
  className?: string
  imageClassName?: string
}

export function ProjectFavicon({
  project,
  className,
  imageClassName,
}: ProjectFaviconProps) {
  const faviconUrl = project.siteProfile?.faviconUrl.trim() ?? ""
  const [failedUrl, setFailedUrl] = React.useState("")
  const failed = faviconUrl !== "" && failedUrl === faviconUrl

  const wrapperClassName = cn(
    "flex size-8 shrink-0 items-center justify-center overflow-hidden",
    className
  )

  if (!project.siteProfile || !faviconUrl || failed) {
    return (
      <span className={wrapperClassName} aria-hidden="true">
        <Globe2 className="size-5 text-muted-foreground" strokeWidth={1.75} />
      </span>
    )
  }

  return (
    <span className={wrapperClassName}>
      <img
        src={faviconUrl}
        alt=""
        className={cn("size-6 object-contain", imageClassName)}
        onError={() => setFailedUrl(faviconUrl)}
      />
    </span>
  )
}
