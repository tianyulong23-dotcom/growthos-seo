import {
  FileText,
  KeyRound,
  SearchCheck,
  Settings2,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react"

import { backlinksNavigation } from "@/features/outreach/manifest"
import { performanceNavigation } from "@/features/performance/manifest"
import type { Project } from "@/features/projects/types"

export type ModuleTab = {
  id: string
  label: string
}

export type ModuleConfig = {
  id: string
  label: string
  description: string
  icon: LucideIcon
  tabs: readonly ModuleTab[]
  action: string
}

export const projects: Project[] = [
  {
    id: "solarreviews",
    name: "Solar Reviews",
    domain: "solarreviews.com",
    country: "美国",
    language: "英语",
    competitorDomain: null,
    understandingRunId: null,
    understandingStatus: "completed",
    understandingStage: "completed",
    understandingMessage: "网站业务识别已完成",
    understandingProgress: 100,
    understandingAttempt: 1,
    understandingStartedAt: null,
    understandingFinishedAt: null,
    understandingElapsedSeconds: 0,
    auditRunId: null,
    auditStatus: "completed",
    auditHealth: 86,
    siteProfile: null,
    createdAt: "2026-07-02",
  },
  {
    id: "growthlab",
    name: "Growth Lab",
    domain: "growthlab.io",
    country: "英国",
    language: "英语",
    competitorDomain: null,
    understandingRunId: null,
    understandingStatus: "completed",
    understandingStage: "completed",
    understandingMessage: "网站业务识别已完成",
    understandingProgress: 100,
    understandingAttempt: 1,
    understandingStartedAt: null,
    understandingFinishedAt: null,
    understandingElapsedSeconds: 0,
    auditRunId: null,
    auditStatus: "completed",
    auditHealth: 73,
    siteProfile: null,
    createdAt: "2026-07-08",
  },
  {
    id: "northstar",
    name: "Northstar 中文站",
    domain: "cn.northstar.com",
    country: "中国",
    language: "简体中文",
    competitorDomain: null,
    understandingRunId: null,
    understandingStatus: "completed",
    understandingStage: "completed",
    understandingMessage: "网站业务识别已完成",
    understandingProgress: 100,
    understandingAttempt: 1,
    understandingStartedAt: null,
    understandingFinishedAt: null,
    understandingElapsedSeconds: 0,
    auditRunId: null,
    auditStatus: "completed",
    auditHealth: 91,
    siteProfile: null,
    createdAt: "2026-07-11",
  },
]

export const modules: ModuleConfig[] = [
  {
    id: "audit",
    label: "网站审计",
    description: "持续发现并修复影响抓取、索引和体验的问题",
    icon: SearchCheck,
    tabs: [
      { id: "overview", label: "概览" },
      { id: "internal", label: "内部资源" },
      { id: "external", label: "外部资源" },
      { id: "status-codes", label: "状态码" },
      { id: "links", label: "链接" },
      { id: "issues", label: "问题清单" },
      { id: "pagespeed", label: "PageSpeed" },
      { id: "visualization", label: "可视化" },
      { id: "history", label: "审计历史" },
    ],
    action: "立即扫描",
  },
  {
    id: "keywords",
    label: "关键词",
    description: "自动发现、整理并管理网站的真实搜索关键词",
    icon: KeyRound,
    tabs: [
      { id: "library", label: "关键词库" },
      { id: "search-performance", label: "搜索表现" },
      { id: "competitor-gap", label: "竞品差距" },
    ],
    action: "",
  },
  {
    id: "content",
    label: "内容",
    description: "从搜索机会到内容计划、生产和发布的完整流程",
    icon: FileText,
    tabs: [
      { id: "plans", label: "内容计划" },
      { id: "library", label: "内容库" },
    ],
    action: "创建内容",
  },
  backlinksNavigation,
  performanceNavigation,
  {
    id: "settings",
    label: "设置",
    description: "管理当前项目的业务资料与服务连接",
    icon: Settings2,
    tabs: [
      { id: "business", label: "业务资料" },
      { id: "connections", label: "服务连接" },
    ],
    action: "",
  },
  {
    id: "platform-settings",
    label: "平台设置",
    description: "管理平台使用的 AI 模型与数据服务",
    icon: SlidersHorizontal,
    tabs: [
      { id: "ai", label: "AI 模型" },
      { id: "dataforseo", label: "DataForSEO" },
      { id: "google-oauth", label: "Google OAuth" },
    ],
    action: "",
  },
]

export const auditRows = [
  {
    item: "缺少或重复的页面标题",
    type: "错误",
    count: 18,
    change: "-4",
    owner: "未分配",
  },
  {
    item: "内部链接指向 4xx 页面",
    type: "错误",
    count: 11,
    change: "+2",
    owner: "技术组",
  },
  {
    item: "图片缺少 alt 文本",
    type: "警告",
    count: 47,
    change: "-9",
    owner: "内容组",
  },
  {
    item: "可索引页面加载时间超过 3 秒",
    type: "警告",
    count: 26,
    change: "-3",
    owner: "技术组",
  },
  {
    item: "页面仅有一个内部入链",
    type: "提示",
    count: 63,
    change: "+5",
    owner: "未分配",
  },
]
