import { cleanup, render, screen } from "@testing-library/react"
import { RouterProvider, createMemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RouteErrorPage } from "@/app/route-error-page"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("RouteErrorPage", () => {
  it("explains that a dynamic module failure does not remove saved work", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const router = createMemoryRouter([
      {
        path: "/",
        loader: () => {
          throw new TypeError(
            "Failed to fetch dynamically imported module: /keyword-workspace.tsx"
          )
        },
        element: <div />,
        errorElement: <RouteErrorPage />,
      },
    ])

    render(<RouterProvider router={router} />)

    expect(
      await screen.findByRole("heading", { name: "页面暂时没有加载成功" })
    ).toBeTruthy()
    expect(
      screen.getByText(/当前后台任务和已保存的数据不会因此丢失/)
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy()
    expect(screen.queryByText("Unexpected Application Error! ")).toBeNull()
  })
})
