from seo_workers.__main__ import WORKER_TYPES


def test_worker_types_are_unique() -> None:
    assert len(WORKER_TYPES) == len(set(WORKER_TYPES))
    assert WORKER_TYPES == ("analysis", "ai", "integration", "publish")
