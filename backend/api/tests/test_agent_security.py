import json

from app.modules.agent.security import sanitize_agent_data, sanitize_text


def test_sensitive_key_variants_and_nested_headers_are_redacted() -> None:
    secret = "sk-live-sensitive-value"
    payload = {
        "apiKey": secret,
        "api-key": secret,
        "authToken": secret,
        "headers": {
            "Authorization": f"Bearer {secret}",
            "X-Client-Secret": secret,
            "Cookie": f"session={secret}",
        },
        "nested": [{"refresh_token": secret}, {"safe": f"Bearer {secret}"}],
    }

    sanitized = sanitize_agent_data(payload, secrets=(secret,))
    encoded = json.dumps(sanitized, ensure_ascii=False)

    assert secret not in encoded
    assert sanitized["apiKey"] == "[REDACTED]"
    assert sanitized["api-key"] == "[REDACTED]"
    assert sanitized["authToken"] == "[REDACTED]"
    assert sanitized["headers"]["Authorization"] == "[REDACTED]"
    assert sanitized["headers"]["Cookie"] == "[REDACTED]"


def test_text_redacts_credentials_in_urls_and_authorization_values() -> None:
    value = "Basic dXNlcjpwYXNz https://user:password@example.com Bearer abc.def"

    sanitized = sanitize_text(value)

    assert "dXNlcjpwYXNz" not in sanitized
    assert "user" not in sanitized
    assert "password" not in sanitized
    assert "abc.def" not in sanitized


def test_text_redacts_pasted_api_keys_and_secret_parameters() -> None:
    secret = "sk-production-sensitive-value"
    value = (
        f"key={secret} api_key={secret} token:plain-sensitive-token "
        f"https://example.com/callback?access_token={secret}"
    )

    sanitized = sanitize_text(value)

    assert secret not in sanitized
    assert "plain-sensitive-token" not in sanitized
    assert sanitized.count("[REDACTED]") >= 3


def test_text_redacts_unregistered_secret_cookie_and_private_key_values() -> None:
    value = (
        "secret=unregistered-value cookie=session-value "
        "private_key=private-value session_id=session-identifier"
    )

    sanitized = sanitize_text(value)

    assert "unregistered-value" not in sanitized
    assert "session-value" not in sanitized
    assert "private-value" not in sanitized
    assert "session-identifier" not in sanitized
