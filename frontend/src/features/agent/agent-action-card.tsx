import type { AgentAction } from "@/features/agent/types"

export function AgentActionCard({ action }: { action: AgentAction }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3 text-xs">
      <div className="font-medium">
        {action.preview.title ?? "历史操作记录"}
      </div>
      {action.preview.impact && (
        <p className="mt-1 leading-5 text-muted-foreground">
          {action.preview.impact}
        </p>
      )}
      {action.preview.changes?.map((change) => (
        <div key={change.field} className="mt-2 border-l-2 pl-2 leading-5">
          <div className="font-medium">{fieldLabel(change.field)}</div>
          <div className="break-words text-muted-foreground">
            {display(change.before)} → {display(change.after)}
          </div>
        </div>
      ))}
      <div className="mt-2 text-muted-foreground">
        {statusLabel(action.status)} · 历史记录仅供查看
      </div>
    </div>
  )
}

function display(value: unknown) {
  if (Array.isArray(value)) return value.join("、") || "空"
  if (value === null || value === undefined || value === "") return "空"
  return String(value)
}

function fieldLabel(value: string) {
  return (
    {
      business_name: "业务名称",
      business_type: "业务类型",
      business_summary: "业务简介",
      target_audiences: "目标受众",
      products_services: "产品与服务",
      value_propositions: "价值主张",
      ai_content_rules: "内容规则",
    }[value] ?? value
  )
}

function statusLabel(status: AgentAction["status"]) {
  return {
    approved: "已批准",
    rejected: "已拒绝，没有执行",
    executing: "当时正在执行",
    completed: "已执行并校验",
    failed: "执行失败",
    expired: "确认已过期",
    pending: "未确认",
  }[status]
}
