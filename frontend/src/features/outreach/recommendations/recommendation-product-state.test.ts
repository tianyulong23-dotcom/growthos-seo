import { describe, expect, it } from "vitest"

import { productStateLabel } from "./recommendation-product-state"

const runningState = {
  productState: "running" as const,
  productStateReason: "REFILL_IN_PROGRESS",
  terminalState: null,
  visibleMatchCount: 4,
  visiblePoolTargetCount: 10,
}

describe("recommendation product state label", () => {
  it.each([
    [
      "terminal state",
      { ...runningState, terminalState: "TARGET_REACHED" as const },
      true,
    ],
    [
      "reason code",
      { ...runningState, productStateReason: "VISIBLE_TARGET_REACHED" },
      true,
    ],
    [
      "completed visible count",
      { ...runningState, visibleMatchCount: 10 },
      false,
    ],
  ])("shows target reached from %s", (_label, inventory, active) => {
    expect(productStateLabel(inventory, active)).toBe("目标已达成")
  })

  it("does not treat an active refill below its terminal contract as complete", () => {
    expect(
      productStateLabel({ ...runningState, visibleMatchCount: 10 }, true)
    ).toBe("处理中")
  })

  it("keeps the existing completed and blocked labels", () => {
    expect(
      productStateLabel(
        { ...runningState, productStateReason: "READY_TO_CONTINUE" },
        false
      )
    ).toBe("本轮已完成")
    expect(
      productStateLabel(
        {
          ...runningState,
          productState: "blocked",
          productStateReason: "UNKNOWN_INTERNAL",
        },
        false
      )
    ).toBe("已阻塞")
  })
})
