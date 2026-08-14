import type { Project } from "@/features/projects/types"

export type OutreachProject = {
  id: string
  name: string
  language: string
  targetUrls: readonly string[]
  profileVersion: number | null
  inputRequired: readonly string[]
}

export function toOutreachProject(project: Project): OutreachProject {
  const profile = project.siteProfile
  const inputRequired = [
    ...(profile?.contentTopics.length ? [] : ["关键词/内容主题"]),
    ...(profile?.productsServices.length ? [] : ["产品或服务"]),
    ...(profile?.keyPages.length ? [] : ["推广目标页"]),
    ...(profile?.targetAudiences.length ? [] : ["目标受众"]),
    "外链合作目标",
  ]

  return {
    id: project.id,
    name: project.name,
    language: project.language,
    targetUrls: profile?.keyPages.map((page) => page.url) ?? [],
    profileVersion: profile?.profileVersion ?? null,
    inputRequired,
  }
}
