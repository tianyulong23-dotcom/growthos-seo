from __future__ import annotations

import json
import math
from typing import Any


def estimate_text_tokens(text: str) -> int:
    """Conservative model-agnostic estimate for multilingual prompt text."""
    tokens = 0
    ascii_word_chars = 0
    for character in text:
        if character.isascii() and character.isalnum():
            ascii_word_chars += 1
            continue
        if ascii_word_chars:
            tokens += math.ceil(ascii_word_chars / 4)
            ascii_word_chars = 0
        if not character.isspace():
            tokens += 1
    if ascii_word_chars:
        tokens += math.ceil(ascii_word_chars / 4)
    return tokens


def estimate_json_tokens(value: Any) -> int:
    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return estimate_text_tokens(serialized)


def truncate_text_to_tokens(text: str, max_tokens: int) -> str:
    if max_tokens < 1:
        return ""
    if estimate_text_tokens(text) <= max_tokens:
        return text
    low, high = 0, len(text)
    while low < high:
        midpoint = (low + high + 1) // 2
        if estimate_text_tokens(text[:midpoint]) <= max_tokens:
            low = midpoint
        else:
            high = midpoint - 1
    return text[:low]
