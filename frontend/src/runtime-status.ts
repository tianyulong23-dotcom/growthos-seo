import { apiRequest } from "@/api/client"

export type RuntimeStatus = {
  status: "ok" | "maintenance"
  business_consumers_running: boolean
}

export function getRuntimeStatus(signal?: AbortSignal) {
  return apiRequest<RuntimeStatus>("/api/v1/runtime-status", { signal })
}
