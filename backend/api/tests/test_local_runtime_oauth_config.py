from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEV_UP = REPOSITORY_ROOT / "scripts" / "dev-up.ps1"
API_ENV_EXAMPLE = REPOSITORY_ROOT / "backend" / "api" / ".env.example"
COMPOSE_ENV_EXAMPLE = REPOSITORY_ROOT / "deploy" / "compose" / ".env.example"
COMPOSE_FILE = REPOSITORY_ROOT / "deploy" / "compose" / "compose.yaml"


def test_dev_up_preserves_business_profile_ai_configuration() -> None:
    startup = DEV_UP.read_text(encoding="utf-8")
    for name in ("BUSINESS_PROFILE_AI_BASE_URL", "BUSINESS_PROFILE_AI_API_KEY"):
        assert f'{name} = Get-LocalSetting "{name}"' in startup
        assert f'{name} = ""' not in startup


def test_dev_up_binds_gmail_oauth_callback_to_localhost_platform_and_frontend() -> None:
    startup = DEV_UP.read_text(encoding="utf-8")

    assert (
        '$backlinksOauthFrontendOrigin = Get-RequiredSetting `\n'
        '        "BACKLINKS_OAUTH_FRONTEND_ORIGIN"'
    ) in startup
    assert '"http://localhost:$platformPort"' in startup
    assert '"/api/v1/backlinks/gmail-connections/callback"' in startup
    assert '"http://localhost:$frontendPort"' in startup
    assert "GMAIL_OAUTH_REDIRECT_URI_LOCAL_RUNTIME_MISMATCH" in startup
    assert "GMAIL_OAUTH_FRONTEND_ORIGIN_LOCAL_RUNTIME_MISMATCH" in startup
    assert (
        "BACKLINKS_OAUTH_FRONTEND_ORIGIN = (\n"
        "            $backlinksOauthFrontendOrigin\n"
        "        )"
    ) in startup
    assert (
        "BACKLINKS_OAUTH_CALLBACK_URL = (\n"
        "            $googleOauthRedirectUri\n"
        "        )"
    ) in startup
    assert (
        '"--host",\n'
        '            "localhost",\n'
        '            "--port"'
    ) in startup
    assert '$frontendUrl = "http://localhost:$frontendPort"' in startup


def test_shared_gmail_oauth_examples_use_one_canonical_local_host() -> None:
    api_environment = API_ENV_EXAMPLE.read_text(encoding="utf-8")
    compose_environment = COMPOSE_ENV_EXAMPLE.read_text(encoding="utf-8")

    for environment in (api_environment, compose_environment):
        assert "BACKLINKS_OAUTH_FRONTEND_ORIGIN=http://localhost:5173" in environment
        assert (
            "BACKLINKS_OAUTH_CALLBACK_URL="
            "http://localhost:7200/api/v1/backlinks/gmail-connections/callback"
        ) in environment
        assert "127.0.0.1:5173" not in environment


def test_compose_requires_public_gmail_oauth_origins_for_platform_api() -> None:
    compose = COMPOSE_FILE.read_text(encoding="utf-8")

    assert (
        'BACKLINKS_OAUTH_FRONTEND_ORIGIN: '
        '"${BACKLINKS_OAUTH_FRONTEND_ORIGIN:?Set '
        'BACKLINKS_OAUTH_FRONTEND_ORIGIN in deploy/compose/.env}"'
    ) in compose
    assert (
        'BACKLINKS_OAUTH_CALLBACK_URL: '
        '"${BACKLINKS_OAUTH_CALLBACK_URL:?Set '
        'BACKLINKS_OAUTH_CALLBACK_URL in deploy/compose/.env}"'
    ) in compose


def test_dev_up_recognizes_complete_0068_schema_without_replaying_it() -> None:
    startup = DEV_UP.read_text(encoding="utf-8")

    assert "backlink_rec_cooperation_tenant_identity_uq" in startup
    assert "backlink_opportunity_source_cooperation_path_fk" in startup
    assert "backlink_opportunity_manual_action_events_immutable" in startup
    assert "backlink_opportunity_manual_event_tenant_policy" in startup
    assert "THEN '0068'" in startup
    assert "ELSE '0068-partial'" in startup


def test_dev_up_passes_outbound_proxy_to_core_and_extends_callback_timeout() -> None:
    startup = DEV_UP.read_text(encoding="utf-8")

    assert '$outboundProxyMode = Get-LocalSetting "OUTBOUND_PROXY_MODE" "explicit"' in startup
    assert "Get-WindowsSystemProxyUrl" in startup
    assert "Resolve-OutboundProxyUrl" in startup
    assert "Assert-OutboundProxyEndpointReachable" in startup
    assert "OUTBOUND_PROXY_MODE_INVALID" in startup
    assert "OUTBOUND_PROXY_UNREACHABLE" in startup
    assert '$outboundHttpProxy = Get-LocalSetting "HTTP_PROXY"' in startup
    assert '$outboundHttpsProxy = Get-LocalSetting "HTTPS_PROXY"' in startup
    assert '$outboundNoProxy = Get-LocalSetting "NO_PROXY"' in startup
    assert '$nodeUseEnvProxy = Get-LocalSetting "NODE_USE_ENV_PROXY"' in startup
    assert "OUTBOUND_PROXY_LOCAL_BYPASS_REQUIRED" in startup
    assert "Assert-OutboundProxyEndpointReachable @(" in startup
    assert "$providerEnvironment[$proxySetting.Key] = $proxySetting.Value" in startup
    assert (
        "BACKLINKS_REQUEST_TIMEOUT_SECONDS = (\n"
        "            $backlinksRequestTimeoutSeconds\n"
        "        )"
    ) in startup
