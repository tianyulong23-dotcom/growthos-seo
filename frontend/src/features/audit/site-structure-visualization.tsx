import * as React from "react"
import cytoscape, {
  type Core,
  type ElementDefinition,
  type EventObjectNode,
  type LayoutOptions,
} from "cytoscape"
import { Download, RotateCcw } from "lucide-react"

import type { AuditVisualization, AuditVisualizationNode } from "@/api/audits"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type VisualizationLayout =
  "cose" | "breadthfirst" | "circle" | "concentric" | "grid"

type VisualizationFilter = "all" | "html" | "2xx" | "3xx" | "4xx" | "5xx"

type TooltipState = {
  x: number
  y: number
  url: string
  title: string
  statusCode: number
}

const statusColors = {
  success: "#10b981",
  redirect: "#3b82f6",
  clientError: "#f59e0b",
  serverError: "#ef4444",
  other: "#6b7280",
}

const layoutLabels: Record<VisualizationLayout, string> = {
  cose: "力导向布局",
  breadthfirst: "层级布局",
  circle: "圆形布局",
  concentric: "同心圆布局",
  grid: "网格布局",
}

const filterLabels: Record<VisualizationFilter, string> = {
  all: "全部页面",
  html: "仅 HTML",
  "2xx": "2xx 成功",
  "3xx": "3xx 重定向",
  "4xx": "4xx 错误",
  "5xx": "5xx 错误",
}

function statusCode(node: AuditVisualizationNode) {
  const nestedRaw =
    node.raw.raw !== null &&
    typeof node.raw.raw === "object" &&
    !Array.isArray(node.raw.raw)
      ? (node.raw.raw as Record<string, unknown>)
      : null
  const value = node.raw.status_code ?? nestedRaw?.status_code
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function statusColor(code: number) {
  if (code >= 200 && code < 300) return statusColors.success
  if (code >= 300 && code < 400) return statusColors.redirect
  if (code >= 400 && code < 500) return statusColors.clientError
  if (code >= 500 && code < 600) return statusColors.serverError
  return statusColors.other
}

function graphLabel(url: string) {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/$/, "")
    return path.split("/").filter(Boolean).at(-1) || parsed.hostname
  } catch {
    return url.split("/").filter(Boolean).at(-1) || url
  }
}

function isHtmlPage(url: string, code: number) {
  if (code < 200 || code >= 300) return false
  try {
    const path = new URL(url).pathname.toLowerCase()
    const finalSegment = path.split("/").filter(Boolean).at(-1) ?? ""
    return (
      path.endsWith("/") ||
      finalSegment === "" ||
      finalSegment.endsWith(".html") ||
      finalSegment.endsWith(".htm") ||
      !finalSegment.includes(".")
    )
  } catch {
    return (
      url.endsWith("/") ||
      url.endsWith(".html") ||
      url.endsWith(".htm") ||
      !url.includes(".")
    )
  }
}

function matchesFilter(
  node: AuditVisualizationNode,
  filter: VisualizationFilter
) {
  const code = statusCode(node)
  if (filter === "all") return true
  if (filter === "html") return isHtmlPage(node.url, code)
  if (filter === "2xx") return code >= 200 && code < 300
  if (filter === "3xx") return code >= 300 && code < 400
  if (filter === "4xx") return code >= 400 && code < 500
  return code >= 500 && code < 600
}

function layoutOptions(layout: VisualizationLayout, cy: Core): LayoutOptions {
  const common = {
    animate: "end" as const,
    animationDuration: 500,
    fit: true,
    padding: 50,
    avoidOverlap: true,
  }

  if (layout === "cose") {
    return {
      ...common,
      name: "cose",
      nodeRepulsion: 400000,
      nodeOverlap: 20,
      idealEdgeLength: 100,
      edgeElasticity: 100,
      nestingFactor: 5,
      gravity: 80,
      numIter: 1000,
      initialTemp: 200,
      coolingFactor: 0.95,
      minTemp: 1,
      randomize: true,
      componentSpacing: 200,
    }
  }

  if (layout === "breadthfirst") {
    const depths = cy.nodes().map((node) => Number(node.data("depth")) || 0)
    const maxDepth = Math.max(1, ...depths)
    return {
      ...common,
      name: "concentric",
      minNodeSpacing: 50,
      concentric: (node) => maxDepth - (Number(node.data("depth")) || 0),
      levelWidth: () => 1,
      sweep: Math.PI * 2,
    }
  }

  if (layout === "concentric") {
    return {
      ...common,
      name: "concentric",
      minNodeSpacing: 100,
      concentric: (node) => node.degree(),
      levelWidth: () => 2,
    }
  }

  return { ...common, name: layout }
}

function EmptyState() {
  return (
    <div className="border-y py-14 text-center">
      <div className="font-medium">暂无站点结构</div>
      <div className="mt-1 text-sm text-muted-foreground">
        完成页面抓取和内部链接分析后生成结构图。
      </div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
      正在读取站点结构
    </div>
  )
}

export function SiteStructureVisualization({
  graph,
  loading,
}: {
  graph: AuditVisualization | null
  loading: boolean
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const cyRef = React.useRef<Core | null>(null)
  const lastTapRef = React.useRef({ nodeId: "", timestamp: 0 })
  const [layout, setLayout] = React.useState<VisualizationLayout>("cose")
  const [filter, setFilter] = React.useState<VisualizationFilter>("all")
  const [visibleCount, setVisibleCount] = React.useState(0)
  const [tooltip, setTooltip] = React.useState<TooltipState | null>(null)

  React.useEffect(() => {
    const container = containerRef.current
    if (!container || loading || !graph || graph.nodes.length === 0) return

    const cy = cytoscape({
      container,
      elements: [],
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            label: "data(label)",
            width: "data(size)",
            height: "data(size)",
            "font-size": "11px",
            color: "#334155",
            "text-outline-color": "#ffffff",
            "text-outline-width": 2,
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 5,
            "overlay-opacity": 0,
            "border-width": 2,
            "border-color": "#ffffff",
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-color": "#7c3aed",
            "border-width": 3,
            "overlay-opacity": 0,
          },
        },
        {
          selector: "node.highlighted",
          style: {
            "border-color": "#7c3aed",
            "border-width": 4,
            opacity: 1,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#94a3b8",
            "target-arrow-color": "#94a3b8",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "arrow-scale": 0.8,
            opacity: 0.55,
          },
        },
        {
          selector: "edge.highlighted",
          style: {
            "line-color": "#7c3aed",
            "target-arrow-color": "#7c3aed",
            width: 3,
            opacity: 1,
          },
        },
        {
          selector: ".dimmed",
          style: {
            opacity: 0.12,
          },
        },
      ],
      layout: { name: "preset" },
      wheelSensitivity: 0.2,
      minZoom: 0.1,
      maxZoom: 3,
      boxSelectionEnabled: false,
    })

    const showTooltip = (event: EventObjectNode) => {
      const node = event.target
      setTooltip({
        x: event.renderedPosition.x + 12,
        y: event.renderedPosition.y + 12,
        url: String(node.data("url") ?? ""),
        title: String(node.data("title") ?? ""),
        statusCode: Number(node.data("statusCode")) || 0,
      })
    }

    cy.on("mouseover", "node", showTooltip)
    cy.on("mousemove", "node", showTooltip)
    cy.on("mouseout", "node", () => setTooltip(null))
    cy.on("tap", "node", (event) => {
      const node = event.target
      const neighborhood = node.neighborhood().add(node)
      cy.elements().removeClass("highlighted dimmed")
      neighborhood.addClass("highlighted")
      cy.elements().not(neighborhood).addClass("dimmed")

      const now = Date.now()
      const nodeId = node.id()
      const lastTap = lastTapRef.current
      if (lastTap.nodeId === nodeId && now - lastTap.timestamp <= 350) {
        const url = String(node.data("url") ?? "")
        if (url) window.open(url, "_blank", "noopener,noreferrer")
        lastTapRef.current = { nodeId: "", timestamp: 0 }
      } else {
        lastTapRef.current = { nodeId, timestamp: now }
      }
    })
    cy.on("tap", (event) => {
      if (event.target === cy) {
        cy.elements().removeClass("highlighted dimmed")
      }
    })

    cyRef.current = cy
    return () => {
      cy.destroy()
      cyRef.current = null
    }
  }, [graph, loading])

  React.useEffect(() => {
    const cy = cyRef.current
    if (!cy || !graph) return

    const filteredNodes = graph.nodes.filter((node) =>
      matchesFilter(node, filter)
    )
    const nodeIds = new Set(filteredNodes.map((node) => node.id))
    const elements: ElementDefinition[] = filteredNodes.map((node) => {
      const code = statusCode(node)
      return {
        group: "nodes",
        data: {
          id: node.id,
          label: graphLabel(node.url),
          url: node.url,
          title: node.label,
          statusCode: code,
          color: statusColor(code),
          size: node.depth === 0 ? 30 : 20,
          depth: node.depth ?? 0,
          issueCount: node.issue_count,
        },
      }
    })

    for (const edge of graph.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
      elements.push({
        group: "edges",
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label,
        },
      })
    }

    cy.elements().remove()
    cy.add(elements)
    setVisibleCount(filteredNodes.length)
    setTooltip(null)
    if (filteredNodes.length > 0) {
      cy.layout(layoutOptions(layout, cy)).run()
    }
  }, [filter, graph, layout])

  function resetView() {
    const cy = cyRef.current
    if (!cy || cy.elements().empty()) return
    cy.elements().removeClass("highlighted dimmed")
    cy.fit(undefined, 50)
    setTooltip(null)
  }

  function exportPng() {
    const cy = cyRef.current
    if (!cy || cy.elements().empty()) return
    const blob = cy.png({
      output: "blob",
      bg: "#ffffff",
      full: true,
      scale: 2,
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "site-structure-visualization.png"
    link.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <LoadingState />
  if (!graph || graph.nodes.length === 0) return <EmptyState />

  return (
    <section className="overflow-hidden rounded-md border">
      <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-sm font-medium">站点页面与内部链接</div>
          <div className="mt-1 text-xs text-muted-foreground">
            显示 {visibleCount} / {graph.nodes.length} 个页面
            {graph.truncated ? `，站点总计 ${graph.total_nodes} 个页面` : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={layout}
            onValueChange={(value) => setLayout(value as VisualizationLayout)}
          >
            <SelectTrigger className="w-[146px]" aria-label="结构图布局">
              <SelectValue>{layoutLabels[layout]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(layoutLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as VisualizationFilter)}
          >
            <SelectTrigger className="w-[132px]" aria-label="结构图筛选">
              <SelectValue>{filterLabels[filter]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(filterLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            title="重置视图"
            aria-label="重置视图"
            onClick={resetView}
          >
            <RotateCcw />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            title="导出 PNG"
            aria-label="导出 PNG"
            onClick={exportPng}
          >
            <Download />
          </Button>
        </div>
      </div>

      <div className="relative h-[min(68vh,720px)] min-h-[440px] bg-muted/20">
        <div
          ref={containerRef}
          className="size-full"
          data-testid="site-structure-graph"
          aria-label="网站页面链接结构图"
        />
        {visibleCount === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            当前筛选条件下没有页面
          </div>
        )}
        {tooltip && (
          <div
            className="pointer-events-none absolute z-10 max-w-[min(360px,calc(100%-24px))] rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            <div className="truncate font-medium">{tooltip.url}</div>
            <div className="mt-1 truncate text-muted-foreground">
              标题：{tooltip.title || "无"}
            </div>
            <div className="mt-1">状态码：{tooltip.statusCode || "-"}</div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-2 border-t px-4 py-3 text-xs text-muted-foreground">
        {[
          ["2xx 成功", statusColors.success],
          ["3xx 重定向", statusColors.redirect],
          ["4xx 错误", statusColors.clientError],
          ["5xx 错误", statusColors.serverError],
          ["其他", statusColors.other],
        ].map(([label, color]) => (
          <div key={label} className="flex items-center gap-2">
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: color }}
            />
            {label}
          </div>
        ))}
        <span className="ml-auto">单击突出关联页面，双击打开页面</span>
      </div>
    </section>
  )
}
