import base64
import hashlib
import json
from unittest.mock import patch

import pytest

from growthos_provider_archive import begin_capture
from app.modules.content.dataforseo import DataForSEOClient, DataForSEOOutcomeUnknown


@pytest.fixture
def spool(tmp_path, monkeypatch):
    monkeypatch.setenv("PROVIDER_ARCHIVE_ENABLED", "true")
    monkeypatch.setenv("PROVIDER_ARCHIVE_DEPLOYMENT_ID", "python-a")
    monkeypatch.setenv("PROVIDER_ARCHIVE_SPOOL_DIR", str(tmp_path))
    return tmp_path


def test_distinct_calls_same_domain_retain_history(spool):
    body = b' {"domain":"example.test","rank":0} '
    for _ in range(2):
        capture = begin_capture(
            "content-serp", "https://api.dataforseo.com/v3/test", "GET"
        )
        assert capture is not None
        capture.finish(body, 200)
    files = list(spool.glob("*.event.json"))
    assert len(files) == 2
    events = [json.loads(p.read_text()) for p in files]
    assert len({e["eventId"] for e in events}) == 2
    for event in events:
        assert base64.b64decode(event["responseBodyBase64"]) == body
        assert event["responseSha256"] == hashlib.sha256(body).hexdigest()
    assert not list(spool.glob("*.pending"))


def test_disabled_config_needs_no_directory(monkeypatch):
    monkeypatch.delenv("PROVIDER_ARCHIVE_ENABLED", raising=False)
    assert begin_capture("test", "https://api.dataforseo.com/v3/test", "GET") is None


def test_account_details_excluded(spool):
    assert begin_capture(
        "test", "https://api.dataforseo.com/v3/appendix/user_data", "GET"
    ) is None
    assert not list(spool.iterdir())


def test_transport_failure_record_and_capacity_preflight(spool, monkeypatch):
    capture = begin_capture("test", "https://api.dataforseo.com/v3/test", "GET")
    capture.finish(b"", None)
    event = json.loads(next(spool.glob("*.event.json")).read_text())
    assert event["outcome"] == "transport_error"
    assert event["httpStatus"] is None
    monkeypatch.setenv("PROVIDER_ARCHIVE_MAX_PENDING", "1")
    with pytest.raises(ValueError, match="CAPACITY"):
        begin_capture("test", "https://api.dataforseo.com/v3/test", "GET")


def test_capture_failure_leaves_marker_without_raising(spool, monkeypatch, caplog):
    monkeypatch.setenv("PROVIDER_ARCHIVE_MAX_RESPONSE_BYTES", "1")
    capture = begin_capture("test", "https://api.dataforseo.com/v3/test", "GET")
    capture.finish(b"large", 200)
    assert len(list(spool.glob("*.pending"))) == 1
    assert "ARCHIVE_CAPTURE_GAP" in caplog.text


def test_content_transport_archives_invalid_json_before_parser(spool):
    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b"malformed-json"

    # The object is configured explicitly; no credential lookup or provider calls.
    client = object.__new__(DataForSEOClient)
    client.login = "fixture-login"
    client.password = "fixture-password"
    client.base_url = "https://api.dataforseo.com"
    client.timeout_seconds = 1
    with patch("app.modules.content.dataforseo.urlopen", return_value=Response()) as call:
        with pytest.raises(DataForSEOOutcomeUnknown):
            client._request_json("GET", "/v3/test")
        assert call.call_count == 1
    event = json.loads(next(spool.glob("*.event.json")).read_text())
    assert base64.b64decode(event["responseBodyBase64"]) == b"malformed-json"
    assert "fixture-password" not in json.dumps(event)
