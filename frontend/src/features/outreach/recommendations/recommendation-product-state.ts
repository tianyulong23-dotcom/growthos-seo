import type { RecommendationInventoryStatus } from "./api"

type RecommendationProductState = Pick<
  RecommendationInventoryStatus,
  | "productState"
  | "productStateReason"
  | "terminalState"
  | "visibleMatchCount"
  | "visiblePoolTargetCount"
>

const productStateLabels: Record<
  RecommendationInventoryStatus["productState"],
  string
> = {
  running: "处理中",
  waiting_retry: "等待重试",
  paused_provider: "数据服务暂停",
  partial_exhausted: "部分完成",
  maintenance: "维护中",
  blocked: "已阻塞",
}

export function productStateLabel(
  inventory: RecommendationProductState,
  active: boolean
) {
  if (
    inventory.terminalState === "TARGET_REACHED" ||
    inventory.productStateReason === "VISIBLE_TARGET_REACHED" ||
    (!active &&
      inventory.visiblePoolTargetCount > 0 &&
      inventory.visibleMatchCount >= inventory.visiblePoolTargetCount)
  ) {
    return "目标已达成"
  }
  if (inventory.productStateReason === "READY_TO_CONTINUE" && !active) {
    return "本轮已完成"
  }
  return productStateLabels[inventory.productState]
}
