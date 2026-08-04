from __future__ import annotations

from app.modules.agent.providers.openai import OpenAIProvider


class OpenRouterProvider(OpenAIProvider):
    def headers(self) -> dict[str, str]:
        return {
            **super().headers(),
            "HTTP-Referer": "https://seo.local",
            "X-Title": "SEO Agent",
        }
