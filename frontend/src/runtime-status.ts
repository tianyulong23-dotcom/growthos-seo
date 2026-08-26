import { apiRequest } from "@/api/client"

export type ProviderRuntimeStatus = {
  configured: boolean
  external_availability: "disabled" | "not_checked" | "available" | "unavailable"
  reason_code: string | null
  recovery_action: string | null
}

export type RuntimeStatus = {
  status: "ok" | "maintenance" | "unavailable"
  mode: "PRODUCT" | "MAINTENANCE" | "RECOVERY"
  business_consumers_running: boolean
  core_api: {
    running: boolean
    build_id: string | null
  }
  worker: {
    process_running: boolean
    build_id: string | null
    execution_mode: "normal" | "quiesced" | "recovery" | "unavailable"
    postgres_ready: boolean
    temporal_ready: boolean
    reason_code: string | null
    recovery_action: string | null
    tasks: {
      status: "ok" | "unavailable"
      active_jobs: number
      recoverable_queued_project_analysis: number
      unrecoverable_stale_queued_project_analysis: number
      stale_running_jobs: number
      waiting_provider_jobs: number
      oldest_active_at: string | null
      reason_code: string | null
      recovery_action: string | null
    }
  }
  build: {
    current: boolean
    expected_build_id: string | null
    core_api_build_id: string | null
    worker_build_id: string | null
    reason_code:
      | "runtime_build_identity_missing"
      | "runtime_build_mismatch"
      | "runtime_build_stale"
      | null
    recovery_action: "restart_product_runtime" | null
  }
  platform: {
    background_dispatch_enabled: boolean
    project_context_projection_enabled: boolean
    project_context_dispatcher_running: boolean
    reason_code: string | null
    recovery_action: string | null
    projection_delivery: {
      status: "ok" | "unavailable"
      due_pending: number
      retryable_failed: number
      permanent_failed: number
      exhausted: number
      oldest_waiting_at: string | null
      latest_failure_code: string | null
      latest_error: string | null
      reason_code: string | null
      recovery_action: string | null
    }
  }
  providers: {
    data_for_seo: ProviderRuntimeStatus
    browser: ProviderRuntimeStatus
    ai: ProviderRuntimeStatus
    gmail: ProviderRuntimeStatus
  }
}

export function getRuntimeStatus(signal?: AbortSignal) {
  return apiRequest<RuntimeStatus>("/api/v1/runtime-status", { signal })
}
