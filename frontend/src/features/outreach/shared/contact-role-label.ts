export function contactRoleLabel(value: string): string {
  const labels: Record<string, string> = {
    editorial: "编辑",
    press: "媒体",
    partnerships: "合作",
    advertising: "广告",
    support: "支持",
    general: "通用",
    business: "商务",
    marketing: "市场",
    site_owner: "网站负责人",
  }
  return labels[value] ?? "其他联系人"
}
