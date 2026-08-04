import type {
  ArticlePublicationStatus,
  ArticleStatus,
} from "@/api/articles"

export const ARTICLE_STATUS_LABELS: Record<ArticleStatus, string> = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  completed_with_warnings: "已完成，部分资料未取得",
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
  cancelled: "已取消",
}

export function articleStatusLabel(status: ArticleStatus) {
  return ARTICLE_STATUS_LABELS[status]
}

export function articlePublicationLabel(status: ArticlePublicationStatus) {
  return status === "publish_ready" ? "完成稿" : "完整草稿"
}

export function articleStageLabel(stage: string) {
  return ARTICLE_STAGE_LABELS[stage] ?? stage
}
