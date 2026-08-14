import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GSCOAuthSettings } from "@/features/settings/gsc-oauth-settings"

const settingsApi = vi.hoisted(() => ({
  getGSCOAuthSettings: vi.fn(),
  updateGSCOAuthSettings: vi.fn(),
}))

vi.mock("@/api/settings", () => settingsApi)

const configuredSettings = {
  clientId: "saved-client-id.apps.googleusercontent.com",
  configured: true,
  clientSecretConfigured: true,
  oauthRedirectUri: "http://127.0.0.1:8004/api/v1/gsc/oauth/callback",
  source: "database" as const,
  updatedAt: "2026-08-11T12:00:00Z",
}

describe("GSCOAuthSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsApi.getGSCOAuthSettings.mockResolvedValue(configuredSettings)
    settingsApi.updateGSCOAuthSettings.mockResolvedValue(configuredSettings)
  })

  afterEach(() => {
    cleanup()
  })

  it("loads the client id and never renders the stored secret", async () => {
    render(<GSCOAuthSettings projectId="project-1" />)

    expect(
      await screen.findByDisplayValue(
        "saved-client-id.apps.googleusercontent.com"
      )
    ).toBeTruthy()
    const secret = screen.getByLabelText(
      "OAuth Client Secret"
    ) as HTMLInputElement
    expect(secret.value).toBe("")
    expect(secret.type).toBe("password")
    expect(screen.getByText("已配置")).toBeTruthy()
    expect(
      screen.getByDisplayValue(
        "http://127.0.0.1:8004/api/v1/gsc/oauth/callback"
      )
    ).toBeTruthy()
  })

  it("saves a replacement client and secret", async () => {
    render(<GSCOAuthSettings projectId="project-1" />)
    await screen.findByDisplayValue(
      "saved-client-id.apps.googleusercontent.com"
    )

    fireEvent.change(screen.getByLabelText("OAuth Client ID"), {
      target: { value: "new-client-id.apps.googleusercontent.com" },
    })
    fireEvent.change(screen.getByLabelText("OAuth Client Secret"), {
      target: { value: "new-client-secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }))

    await waitFor(() => {
      expect(settingsApi.updateGSCOAuthSettings).toHaveBeenCalledWith(
        "project-1",
        {
          clientId: "new-client-id.apps.googleusercontent.com",
          clientSecret: "new-client-secret",
        }
      )
    })
    expect(
      await screen.findByText(
        "Google OAuth 设置已保存，项目成员现在可以连接 Search Console"
      )
    ).toBeTruthy()
  })

  it("keeps the saved secret when only the client id changes", async () => {
    render(<GSCOAuthSettings projectId="project-1" />)
    await screen.findByDisplayValue(
      "saved-client-id.apps.googleusercontent.com"
    )

    fireEvent.change(screen.getByLabelText("OAuth Client ID"), {
      target: { value: "updated-client-id.apps.googleusercontent.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }))

    await waitFor(() => {
      expect(settingsApi.updateGSCOAuthSettings).toHaveBeenCalledWith(
        "project-1",
        { clientId: "updated-client-id.apps.googleusercontent.com" }
      )
    })
  })
})
