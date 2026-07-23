from app.db.base import Base
from app.modules.crawling import models as crawling_models  # noqa: F401


def test_crawler_tables_are_registered() -> None:
    assert {
        "crawl_runs",
        "pages",
        "page_snapshots",
        "link_edges",
        "backlink_checks",
    }.issubset(Base.metadata.tables)
    assert "word_count" in Base.metadata.tables["page_snapshots"].columns
