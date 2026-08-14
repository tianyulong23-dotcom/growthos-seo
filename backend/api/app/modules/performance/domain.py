from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import urlsplit, urlunsplit


PerformanceStatus = Literal[
    "waiting_data",
    "insufficient_data",
    "impressions",
    "clicks",
    "growing",
    "stable",
    "declining",
    "observing_update",
]


@dataclass(frozen=True)
class Metrics:
    clicks: float = 0
    impressions: float = 0
    position: float = 0

    @property
    def ctr(self) -> float:
        return self.clicks / self.impressions if self.impressions > 0 else 0


@dataclass(frozen=True)
class PerformanceAssessment:
    status: PerformanceStatus
    signals: tuple[tuple[str, str], ...] = ()


MIN_PUBLISHED_DAYS = 14
UPDATE_OBSERVATION_DAYS = 14
MIN_PERIOD_IMPRESSIONS = 50
HIGH_IMPRESSIONS = 200
LOW_CTR = 0.01
MEANINGFUL_CHANGE = 0.25
POSITION_DECLINE = 2.0


def normalize_published_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("published_url_invalid")
    if parsed.username or parsed.password:
        raise ValueError("published_url_invalid")
    scheme = parsed.scheme.casefold()
    hostname = parsed.hostname.casefold()
    port = parsed.port
    netloc = hostname
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        netloc = f"{hostname}:{port}"
    return urlunsplit((scheme, netloc, parsed.path or "/", parsed.query, ""))


def percentage_change(current: float, previous: float) -> float | None:
    if previous == 0:
        return None
    return (current - previous) / previous


def assess_article_performance(
    *,
    current: Metrics,
    previous: Metrics,
    published_at: datetime,
    last_published_at: datetime,
    now: datetime | None = None,
    complete_comparison_window: bool,
    complete_current_window: bool | None = None,
) -> PerformanceAssessment:
    current_time = now or datetime.now(UTC)
    age_days = max((current_time.date() - published_at.date()).days, 0)
    update_age_days = max((current_time.date() - last_published_at.date()).days, 0)

    if last_published_at > published_at and update_age_days < UPDATE_OBSERVATION_DAYS:
        return PerformanceAssessment("observing_update")
    if age_days < MIN_PUBLISHED_DAYS:
        return PerformanceAssessment("waiting_data")
    signals: list[tuple[str, str]] = []
    current_window_ready = (
        complete_comparison_window if complete_current_window is None else complete_current_window
    )
    if current_window_ready:
        if current.impressions == 0:
            signals.append(("no_impressions", "发布一段时间后仍无搜索曝光"))
        if current.impressions >= HIGH_IMPRESSIONS and current.ctr < LOW_CTR:
            signals.append(("high_impressions_low_ctr", "曝光较高，但点击率低于 1%"))
    if not complete_comparison_window:
        return PerformanceAssessment(_sample_status(current).status, tuple(signals))

    if (
        current.impressions < MIN_PERIOD_IMPRESSIONS
        or previous.impressions < MIN_PERIOD_IMPRESSIONS
    ):
        return PerformanceAssessment(_sample_status(current).status, tuple(signals))

    impression_change = percentage_change(current.impressions, previous.impressions) or 0
    click_change = percentage_change(current.clicks, previous.clicks)
    ctr_change = percentage_change(current.ctr, previous.ctr)
    position_worsened = current.position - previous.position

    if ctr_change is not None and ctr_change <= -MEANINGFUL_CHANGE:
        signals.append(("ctr_decline", "曝光样本充足，点击率较上一周期下降"))
    declining = impression_change <= -MEANINGFUL_CHANGE and (
        position_worsened >= POSITION_DECLINE
        or (click_change is not None and click_change <= -MEANINGFUL_CHANGE)
    )
    if declining:
        signals.append(("visibility_decline", "曝光下降且平均排名或点击同步走弱"))
        return PerformanceAssessment("declining", tuple(signals))
    if impression_change >= MEANINGFUL_CHANGE or (
        click_change is not None and click_change >= MEANINGFUL_CHANGE
    ):
        return PerformanceAssessment("growing", tuple(signals))
    return PerformanceAssessment("stable", tuple(signals))


def _sample_status(metrics: Metrics) -> PerformanceAssessment:
    if metrics.clicks > 0:
        return PerformanceAssessment("clicks")
    if metrics.impressions > 0:
        return PerformanceAssessment("impressions")
    return PerformanceAssessment("insufficient_data")
