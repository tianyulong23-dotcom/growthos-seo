import type { Project } from "@/features/projects/types"

export type OutreachProject = {
  id: string
  name: string
  domain: string
  language: string
  contextVersion: number
  targetUrls: readonly string[]
  suggestedTopics: readonly string[]
  suggestedTargetUrls: readonly string[]
  profileVersion: number | null
  inputRequired: readonly string[]
}

function belongsToProject(url: string, projectDomain: string) {
  try {
    const hostname = new URL(url).hostname
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "")
    const canonicalProjectDomain = projectDomain
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "")
    return (
      hostname === canonicalProjectDomain ||
      hostname.endsWith(`.${canonicalProjectDomain}`)
    )
  } catch {
    return false
  }
}

export function toOutreachProject(project: Project): OutreachProject {
  const profile = project.siteProfile
  const suggestedTopics =
    profile?.contentTopics.length
      ? profile.contentTopics
      : (profile?.productsServices ?? [])
  const suggestedTargetUrls = Array.from(
    new Set([
      ...(profile?.keyPages.map((page) => page.url) ?? []),
      ...(profile?.evidence
        .map((item) => item.sourceUrl)
        .filter((url) => belongsToProject(url, project.domain)) ?? []),
    ])
  ).slice(0, 5)
  const inputLabels: Record<string, string> = {
    products: "产品或服务",
    keywords: "关键词/内容主题",
    target_urls: "推广目标页",
    target_audiences: "目标受众",
    partnership_goals: "外链合作目标",
  }
  const inputRequired =
    profile?.inputRequired?.map((field) => inputLabels[field] ?? field) ?? [
      ...(profile?.contentTopics.length ? [] : ["关键词/内容主题"]),
      ...(profile?.productsServices.length ? [] : ["产品或服务"]),
      ...(profile?.keyPages.length ? [] : ["推广目标页"]),
      ...(profile?.targetAudiences.length ? [] : ["目标受众"]),
      ...(profile?.partnershipGoals?.length ? [] : ["外链合作目标"]),
    ]

  return {
    id: project.id,
    name: project.name,
    domain: project.domain,
    language: project.language,
    contextVersion: project.contextVersion ?? 1,
    targetUrls: profile?.keyPages.map((page) => page.url) ?? [],
    suggestedTopics,
    suggestedTargetUrls,
    profileVersion: profile?.profileVersion ?? null,
    inputRequired,
  }
}
