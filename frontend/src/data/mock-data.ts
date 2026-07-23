import {
  BarChart3,
  FileText,
  Gauge,
  KeyRound,
  Link2,
  SearchCheck,
  Settings2,
  type LucideIcon,
} from "lucide-react"

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
  tabs: ModuleTab[]
  action: string
}

export const projects: Project[] = [
  {
    id: "solarreviews",
    name: "Solar Reviews",
    domain: "solarreviews.com",
    country: "美国",
    language: "英语",
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
    id: "overview",
    label: "项目总览",
    description: "项目健康度、增长趋势与待处理事项",
    icon: Gauge,
    tabs: [],
    action: "查看报告",
  },
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
    description: "管理关键词库，发现机会并跟踪搜索排名",
    icon: KeyRound,
    tabs: [
      { id: "library", label: "关键词库" },
      { id: "opportunities", label: "机会发现" },
      { id: "rankings", label: "排名跟踪" },
    ],
    action: "添加关键词",
  },
  {
    id: "content",
    label: "内容",
    description: "从搜索机会到内容计划、生产和发布的完整流程",
    icon: FileText,
    tabs: [
      { id: "opportunities", label: "内容机会" },
      { id: "plans", label: "内容计划" },
      { id: "library", label: "内容库" },
    ],
    action: "创建内容",
  },
  {
    id: "backlinks",
    label: "外链",
    description: "发现高价值站点，推进外联并监控链接变化",
    icon: Link2,
    tabs: [
      { id: "prospects", label: "外链机会" },
      { id: "outreach", label: "外联活动" },
      { id: "monitor", label: "链接监控" },
    ],
    action: "添加机会",
  },
  {
    id: "performance",
    label: "效果",
    description: "统一查看搜索、内容和转化表现",
    icon: BarChart3,
    tabs: [
      { id: "search", label: "搜索表现" },
      { id: "content", label: "内容表现" },
    ],
    action: "导出报告",
  },
  {
    id: "settings",
    label: "项目设置",
    description: "管理项目资料、数据源与通知规则",
    icon: Settings2,
    tabs: [
      { id: "business", label: "业务资料" },
      { id: "sources", label: "数据连接" },
      { id: "notifications", label: "通知设置" },
    ],
    action: "保存设置",
  },
]

export const trendData = [
  { date: "7月11日", clicks: 1260, impressions: 18200 },
  { date: "7月12日", clicks: 1390, impressions: 19500 },
  { date: "7月13日", clicks: 1325, impressions: 19100 },
  { date: "7月14日", clicks: 1510, impressions: 20700 },
  { date: "7月15日", clicks: 1680, impressions: 22600 },
  { date: "7月16日", clicks: 1760, impressions: 23800 },
  { date: "7月17日", clicks: 1938, impressions: 25140 },
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

export const keywordRows = [
  {
    keyword: "best solar panels",
    intent: "商业",
    volume: "12,100",
    position: 4,
    change: "+2",
    url: "/best-solar-panels/",
  },
  {
    keyword: "solar panel cost",
    intent: "商业",
    volume: "9,900",
    position: 8,
    change: "-1",
    url: "/solar-panel-cost/",
  },
  {
    keyword: "how do solar panels work",
    intent: "信息",
    volume: "8,100",
    position: 12,
    change: "+5",
    url: "/blog/how-solar-panels-work/",
  },
  {
    keyword: "solar tax credit 2026",
    intent: "信息",
    volume: "6,600",
    position: 17,
    change: "+9",
    url: "/solar-incentives/federal-tax-credit/",
  },
  {
    keyword: "tesla solar roof review",
    intent: "商业",
    volume: "4,400",
    position: 21,
    change: "0",
    url: "/installers/tesla-energy-reviews/",
  },
]

export const contentRows = [
  {
    title: "2026 年太阳能税收抵免完整指南",
    status: "撰写中",
    keyword: "solar tax credit 2026",
    score: 78,
    updated: "10 分钟前",
  },
  {
    title: "家用太阳能电池的真实回本周期",
    status: "待审核",
    keyword: "solar battery payback",
    score: 84,
    updated: "1 小时前",
  },
  {
    title: "SolarEdge 与 Enphase：逆变器对比",
    status: "草稿",
    keyword: "solaredge vs enphase",
    score: 61,
    updated: "昨天",
  },
  {
    title: "佛罗里达州太阳能安装商排名",
    status: "已发布",
    keyword: "solar companies florida",
    score: 92,
    updated: "7月15日",
  },
]

export const backlinkRows = [
  {
    domain: "cleanenergynews.com",
    authority: 72,
    relevance: "高",
    status: "待联系",
    contact: "editor@cleanenergynews.com",
  },
  {
    domain: "greenbuildingadvisor.com",
    authority: 68,
    relevance: "高",
    status: "跟进中",
    contact: "内容编辑",
  },
  {
    domain: "ecowatch.com",
    authority: 81,
    relevance: "中",
    status: "已回复",
    contact: "合作团队",
  },
  {
    domain: "renewableenergyworld.com",
    authority: 76,
    relevance: "高",
    status: "已获得",
    contact: "专栏编辑",
  },
]
