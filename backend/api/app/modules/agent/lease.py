from __future__ import annotations


TOOL_HEARTBEAT_TIMEOUT_SECONDS = 10
TOOL_HEARTBEAT_INTERVAL_SECONDS = TOOL_HEARTBEAT_TIMEOUT_SECONDS / 2
MIN_TOOL_LEASE_RENEWAL_INTERVAL_SECONDS = 0.25


def tool_lease_renewal_interval_seconds(lease_seconds: int) -> float:
    return max(MIN_TOOL_LEASE_RENEWAL_INTERVAL_SECONDS, lease_seconds / 3)
