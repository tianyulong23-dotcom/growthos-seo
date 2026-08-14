import type {
  ArticleDocument,
  ArticleMetadataSnapshot,
} from "@/api/articles"

export type LocalArticleBackup = {
  id: string
  environment: string
  projectId: string
  articleId: string
  recoveryScope: string
  clientId: string
  sequence: number
  baseVersionNumber: number
  baseReviewVersion: number
  document: ArticleDocument
  metadata: ArticleMetadataSnapshot
  contentHash: string
  createdAt: string
}

const PREFIX = "seo:article-recovery:v2:"
const MAX_BACKUPS = 5

function storageKey(input: {
  projectId: string
  articleId: string
  recoveryScope: string
}) {
  return `${PREFIX}${encodeURIComponent(location.origin)}:${encodeURIComponent(input.recoveryScope)}:${encodeURIComponent(input.projectId)}:${encodeURIComponent(input.articleId)}`
}

function parseBackups(value: string | null): LocalArticleBackup[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is LocalArticleBackup =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof (item as LocalArticleBackup).contentHash === "string"
        )
      : []
  } catch {
    return []
  }
}

export function loadLocalArticleBackups(scope: {
  projectId: string
  articleId: string
  recoveryScope: string
}) {
  return parseBackups(localStorage.getItem(storageKey(scope))).sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  )
}

export function saveLocalArticleBackup(backup: LocalArticleBackup) {
  const key = storageKey(backup)
  const prior = loadLocalArticleBackups(backup).filter(
    (item) => item.contentHash !== backup.contentHash
  )
  const next = [backup, ...prior].slice(0, MAX_BACKUPS)
  try {
    localStorage.setItem(key, JSON.stringify(next))
  } catch {
    try {
      localStorage.setItem(key, JSON.stringify([backup]))
    } catch {
      return false
    }
  }
  return true
}

export function discardLocalArticleBackup(
  scope: { projectId: string; articleId: string; recoveryScope: string },
  backupId: string
) {
  const key = storageKey(scope)
  const next = loadLocalArticleBackups(scope).filter(
    (item) => item.id !== backupId
  )
  if (next.length) localStorage.setItem(key, JSON.stringify(next))
  else localStorage.removeItem(key)
}

export function articleClientId(projectId: string, articleId: string) {
  const key = `seo:article-client:v1:${projectId}:${articleId}`
  const current = sessionStorage.getItem(key)
  if (current) return current
  const created = crypto.randomUUID()
  sessionStorage.setItem(key, created)
  return created
}
