from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


CADENCES = {"weekly_1", "weekly_2_3", "weekly_5", "weekly_7"}


class ScheduleError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ScheduledSlot:
    publish_local_date: date
    publish_local_time: time
    schedule_timezone: str
    publish_at: datetime
    generation_at: datetime


def timezone(value: str) -> ZoneInfo:
    try:
        return ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ScheduleError("timezone_required") from exc


def local_monday(now: datetime, timezone_name: str) -> date:
    local_date = now.astimezone(timezone(timezone_name)).date()
    return local_date - timedelta(days=local_date.weekday())


def cadence_accepts(day: date, cadence: str, anchor_week: date | None) -> bool:
    if cadence not in CADENCES:
        raise ScheduleError("invalid_cadence")
    weekday = day.weekday()
    if cadence == "weekly_1":
        return weekday == 2
    if cadence == "weekly_5":
        return weekday < 5
    if cadence == "weekly_7":
        return True
    if anchor_week is None or anchor_week.weekday() != 0:
        raise ScheduleError("cadence_anchor_required")
    week = (day - anchor_week).days // 7
    return weekday in ({1, 3} if week % 2 == 0 else {0, 1, 4})


def make_slot(day: date, publish_time: time, timezone_name: str) -> ScheduledSlot:
    zone = timezone(timezone_name)
    publish_local = datetime.combine(day, publish_time, zone)
    generation_local = datetime.combine(day - timedelta(days=1), time(10), zone)
    return ScheduledSlot(
        publish_local_date=day,
        publish_local_time=publish_time,
        schedule_timezone=timezone_name,
        publish_at=publish_local.astimezone(UTC),
        generation_at=generation_local.astimezone(UTC),
    )


def allocate_slots(
    *,
    count: int,
    cadence: str,
    timezone_name: str,
    publish_time: time,
    anchor_week: date | None,
    occupied_dates: set[date],
    now: datetime,
) -> list[ScheduledSlot]:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    zone = timezone(timezone_name)
    day = now.astimezone(zone).date()
    slots: list[ScheduledSlot] = []
    while len(slots) < count:
        if day not in occupied_dates and cadence_accepts(day, cadence, anchor_week):
            slot = make_slot(day, publish_time, timezone_name)
            if slot.generation_at > now.astimezone(UTC):
                slots.append(slot)
                occupied_dates.add(day)
        day += timedelta(days=1)
    return slots


def publication_blocked_reason(
    *, review_status: str | None, publication_status: str, paused: bool
) -> str | None:
    if review_status == "changes_requested":
        return "changes_requested"
    if review_status != "approved":
        return "awaiting_review"
    if publication_status != "publish_ready":
        return "quality_not_ready"
    if paused:
        return "publishing_paused"
    return None
