import json
from email.message import Message

import pytest

from app.modules.agent.providers.openai import classify_http_error, http_error_diagnostic


def test_diagnostic_preserves_actionable_metadata_without_echoed_content(caplog):
    headers = Message()
    headers["x-request-id"] = "req_" + "a" * 32
    headers["authorization"] = "Bearer private-key"
    body = json.dumps({"error": {
        "type": "invalid_request_error",
        "code": "unsupported_parameter",
        "param": "tools[0].function.parameters",
        "message": "Unsupported parameter. Echo: private-key person@example.com private project",
    }}).encode()

    error = classify_http_error(400, body, headers)

    assert error.code == "model_provider_request_rejected"
    assert not error.retryable
    assert "tools[0].function.parameters" in caplog.text
    assert "req_" + "a" * 32 in caplog.text
    assert "unsupported_parameter" in caplog.text
    for secret in ("private-key", "person@example.com", "private project", "Bearer"):
        assert secret not in caplog.text


@pytest.mark.parametrize("body", [
    b"<html>private-key person@example.com</html>",
    b'{"error": "private-key"}',
    b'[]',
    b'{"error":{"code":[],"type":{},"param":{},"message":[]}}',
    b'{"error":{"code":"private-key","type":"person@example.com",'
    b'"param":"messages[0].content.private-key","message":"private project"}}',
    b"\xff",
    b'{"error":{"message":"' + b"x" * 70_000,
], ids=["html", "string-error", "array", "wrong-types", "echoed-secret", "encoding", "oversized"])
def test_untrusted_or_malformed_error_never_enters_logs(body, caplog):
    headers = Message()
    headers["x-request-id"] = "private-key"
    classify_http_error(400, body, headers)
    assert http_error_diagnostic(400, body, headers) == {"status": 400}
    assert len(caplog.text) < 500
    assert "private-key" not in caplog.text
    assert "person@example.com" not in caplog.text


def test_relay_rate_limit_is_distinguished_without_changing_retry_policy():
    body = json.dumps({"error": {
        "type": "rate_limit_error",
        "message": "All available accounts are currently rate-limited. Please retry later.",
    }}).encode()
    diagnostic = http_error_diagnostic(429, body)
    assert diagnostic["reason"] == "relay_accounts_rate_limited"
    error = classify_http_error(429, body)
    assert error.retryable
    assert error.code == "model_provider_unavailable"
