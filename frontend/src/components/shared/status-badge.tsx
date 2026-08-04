import { Badge } from "@/components/ui/badge"

export function StatusBadge({ value }: { value: string }) {
  const variant =
    value === "错误" || value === "待联系"
      ? "destructive"
      : value === "已发布" || value === "已获得" || value === "已回复"
        ? "default"
        : value === "警告" || value === "跟进中" || value === "待审核"
          ? "secondary"
          : "outline"

  return <Badge variant={variant}>{value}</Badge>
}
