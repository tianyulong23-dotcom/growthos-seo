from datetime import UTC, date, datetime, time

from app.modules.content_plan.scheduling import (
    allocate_slots,
    cadence_accepts,
    make_slot,
    publication_blocked_reason,
)


def test_weekly_2_3_schedule_keeps_order_and_skips_occupied_and_missed_dates() -> None:
    slots = allocate_slots(
        count=5,
        cadence="weekly_2_3",
        timezone_name="America/New_York",
        publish_time=time(10),
        anchor_week=date(2026, 8, 3),
        occupied_dates={date(2026, 8, 6)},
        now=datetime(2026, 8, 3, 15, tzinfo=UTC),
    )
    assert [slot.publish_local_date for slot in slots] == [
        date(2026, 8, 10),
        date(2026, 8, 11),
        date(2026, 8, 14),
        date(2026, 8, 18),
        date(2026, 8, 20),
    ]


def test_generation_time_uses_previous_local_ten_across_dst() -> None:
    before = make_slot(date(2026, 3, 8), time(10), "America/New_York")
    after = make_slot(date(2026, 3, 9), time(10), "America/New_York")
    assert before.generation_at == datetime(2026, 3, 7, 15, tzinfo=UTC)
    assert after.generation_at == datetime(2026, 3, 8, 14, tzinfo=UTC)
    assert after.publish_at == datetime(2026, 3, 9, 14, tzinfo=UTC)


def test_publication_block_reason_uses_fixed_priority() -> None:
    assert publication_blocked_reason(
        review_status="changes_requested", publication_status="complete_draft", paused=True
    ) == "changes_requested"
    assert publication_blocked_reason(
        review_status="pending_review", publication_status="publish_ready", paused=True
    ) == "awaiting_review"
    assert publication_blocked_reason(
        review_status="approved", publication_status="complete_draft", paused=True
    ) == "quality_not_ready"
    assert publication_blocked_reason(
        review_status="approved", publication_status="publish_ready", paused=True
    ) == "publishing_paused"
    assert publication_blocked_reason(
        review_status="approved", publication_status="publish_ready", paused=False
    ) is None


def test_all_supported_cadences_follow_the_documented_weekdays() -> None:
    anchor = date(2026, 8, 3)
    first_week = [anchor.replace(day=3 + offset) for offset in range(7)]
    second_week = [date(2026, 8, 10 + offset) for offset in range(7)]

    assert [day.weekday() for day in first_week if cadence_accepts(day, "weekly_1", None)] == [
        2
    ]
    assert [day.weekday() for day in first_week if cadence_accepts(day, "weekly_5", None)] == [
        0,
        1,
        2,
        3,
        4,
    ]
    assert [day.weekday() for day in first_week if cadence_accepts(day, "weekly_7", None)] == [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
    ]
    assert [
        day.weekday() for day in first_week if cadence_accepts(day, "weekly_2_3", anchor)
    ] == [1, 3]
    assert [
        day.weekday() for day in second_week if cadence_accepts(day, "weekly_2_3", anchor)
    ] == [0, 1, 4]


def test_thirty_slots_are_stable_unique_and_keep_plan_order() -> None:
    occupied_dates = {date(2026, 8, 11), date(2026, 8, 20)}
    arguments = {
        "count": 30,
        "cadence": "weekly_2_3",
        "timezone_name": "Asia/Shanghai",
        "publish_time": time(10),
        "anchor_week": date(2026, 8, 3),
        "now": datetime(2026, 8, 3, 0, tzinfo=UTC),
    }
    first = allocate_slots(**arguments, occupied_dates=set(occupied_dates))
    second = allocate_slots(**arguments, occupied_dates=set(occupied_dates))

    first_dates = [slot.publish_local_date for slot in first]
    assert first_dates == [slot.publish_local_date for slot in second]
    assert len(first_dates) == len(set(first_dates)) == 30
    assert first_dates == sorted(first_dates)
    assert all(slot.publish_local_time == time(10) for slot in first)
