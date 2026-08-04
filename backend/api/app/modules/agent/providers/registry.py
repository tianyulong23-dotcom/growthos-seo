from __future__ import annotations

from app.modules.agent.providers.anthropic import AnthropicProvider
from app.modules.agent.providers.base import ModelProvider, ProviderConfig
from app.modules.agent.providers.openai import OpenAIProvider
from app.modules.agent.providers.openrouter import OpenRouterProvider


def build_provider(config: ProviderConfig) -> ModelProvider:
    if config.provider == "anthropic":
        return AnthropicProvider(config)
    if config.provider == "openrouter":
        return OpenRouterProvider(config)
    if config.provider == "openai":
        return OpenAIProvider(config)
    raise ValueError(f"Unsupported AI provider: {config.provider}")
