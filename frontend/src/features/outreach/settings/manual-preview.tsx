import { createRoot } from "react-dom/client"

import "@/index.css"

import { SettingsWorkspace } from "./settings-workspace"
import type {
  SettingsClient,
  SettingsGovernanceView,
} from "./types"

let governance: SettingsGovernanceView = {
  settings: {
    id: "settings-preview",
    version: 12,
    values: {
      reportingTimezone: "Asia/Shanghai",
      reportLookbackDays: 30,
      exportExpiryHours: 24,
    },
  },
  killSwitches: [
    {
      capability: "provider.deep-domain-check",
      provider: "DataForSEO",
      effectiveBlocked: false,
      sourceLayer: "provider",
      sourceScopeId: "provider-dataforseo",
      sourceVersion: 8,
      editable: true,
    },
    {
      capability: "outreach.send",
      provider: null,
      effectiveBlocked: true,
      sourceLayer: "workspace",
      sourceScopeId: "workspace-preview",
      sourceVersion: 4,
      editable: true,
    },
  ],
  editableKillSwitchLayers: ["project", "provider"],
  retention: {
    id: "retention-preview",
    version: 3,
    rules: [
      { category: "report_export", retainForDays: 7 },
      { category: "metric_snapshot", retainForDays: 730 },
      { category: "audit_event", retainForDays: 2555 },
    ],
    exceptions: [
      "legal_hold",
      "audit_record",
      "lifecycle_record",
      "active_suppression",
    ],
  },
}

const contractClient: SettingsClient = {
  async getSettings() {
    return governance
  },
  async updateSettings(_project, input) {
    governance = {
      ...governance,
      settings: {
        ...governance.settings,
        version: input.expectedVersion + 1,
        values: input.values,
      },
    }
    return { settings: governance.settings }
  },
  async updateKillSwitch(_project, capability, input) {
    const current = governance.killSwitches.find(
      (item) => item.capability === capability
    )!
    const killSwitch = {
      ...current,
      provider: input.provider,
      effectiveBlocked: input.blocked,
      sourceLayer: input.layer,
      sourceVersion: input.expectedVersion + 1,
    }
    governance = {
      ...governance,
      killSwitches: governance.killSwitches.map((item) =>
        item.capability === capability ? killSwitch : item
      ),
    }
    return { killSwitch }
  },
}

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-7xl p-4 sm:p-6">
    <SettingsWorkspace
      websiteProjectKey="preview-project"
      client={contractClient}
    />
  </main>
)
