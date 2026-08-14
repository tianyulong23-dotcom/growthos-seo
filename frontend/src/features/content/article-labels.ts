import type {
  ArticlePublicationStatus,
  ArticleReviewStatus,
  ArticleStatus,
  CmsPublicationStatus,
} from "@/api/articles"

export const ARTICLE_STATUS_LABELS: Record<ArticleStatus, string> = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  completed_with_warnings: "已完成，有提示",
  failed: "生成失败",
  cancelled: "已取消",
}

const ARTICLE_STAGE_LABELS: Record<string, string> = {
  queued: "等待开始",
  preparing: "准备项目资料",
  collecting: "收集搜索与站内资料",
  competitor_research: "分析同类文章",
  planning: "规划文章结构",
  writing: "撰写正文",
  editing: "统一全文",
  checking: "检查质量与引用",
  revising: "修订问题章节",
  completed: "生成完成",
  failed: "生成失败",
  cancelled: "已取消",
}

const REVIEW_LABELS: Record<ArticleReviewStatus, string> = {
  pending_review: "待审核",
  approved: "审核通过",
  changes_requested: "要求修改",
}

const CMS_LABELS: Record<CmsPublicationStatus, string> = {
  queued: "等待发布",
  scheduled: "已定时发布",
  submitting: "发布中",
  published: "已发布到 WordPress",
  failed: "发布失败",
  uncertain: "发布结果待确认",
  cancelled: "发布已取消",
}

const BLOCKED_REASON_LABELS: Record<string, string> = {
  changes_requested: "审核要求修改",
  awaiting_review: "等待审核通过",
  quality_not_ready: "文章质量尚未达到发布标准",
  publishing_paused: "项目已暂停自动发布",
}

export function articleStatusLabel(status: ArticleStatus) {
  return ARTICLE_STATUS_LABELS[status]
}

export function articlePublicationLabel(status: ArticlePublicationStatus) {
  return status === "publish_ready" ? "质量就绪" : "完整草稿"
}

export function articleReviewLabel(status: ArticleReviewStatus | null) {
  return status ? REVIEW_LABELS[status] : "未进入审核"
}

export function cmsPublicationLabel(status: CmsPublicationStatus | null) {
  return status ? CMS_LABELS[status] : "尚未发布"
}

export function publicationBlockedReasonLabel(reason: string | null) {
  return reason ? (BLOCKED_REASON_LABELS[reason] ?? reason) : null
}

export function articleStageLabel(stage: string) {
  return ARTICLE_STAGE_LABELS[stage] ?? stage
}
