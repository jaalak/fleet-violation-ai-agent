"""Provider-neutral LLM interface so the checker can run on Claude, ChatGPT (OpenAI) or Gemini.

Everything above this package (extraction, agent, UI) only uses the types and `LLMProvider` methods
defined here; each provider module translates them to its own SDK.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable, Optional, TypeVar, Union

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


# ---------- Neutral message parts ----------

@dataclass
class Text:
    text: str


@dataclass
class Pdf:
    data: bytes
    filename: str = "document.pdf"


@dataclass
class Image:
    data: bytes
    media_type: str = "image/png"


Part = Union[Text, Pdf, Image]
ToolOutput = Union[str, list[Union[Text, Image]]]


@dataclass
class ToolSpec:
    name: str
    description: str
    args: type[BaseModel]                      # arguments schema
    handler: Callable[[BaseModel], ToolOutput]


@dataclass
class Credentials:
    """What the user picked in the UI. Secrets live only in memory, never on disk."""

    provider: str                              # "anthropic" | "openai" | "gemini"
    method: str = "api_key"                    # "api_key" | "account"
    api_key: Optional[str] = None
    profile: Optional[str] = None              # Anthropic `ant auth login` profile name
    project: Optional[str] = None              # Google Cloud project (Gemini via Vertex AI)
    location: str = "global"
    extra: dict = field(default_factory=dict)


class LLMError(RuntimeError):
    pass


class LLMProvider(ABC):
    label: str = ""

    def __init__(self, creds: Credentials, model: Optional[str] = None):
        self.creds = creds
        self.model = model or ""

    @abstractmethod
    def check(self) -> tuple[bool, str]:
        """Verify the credentials with a cheap call. Returns (ok, human-readable message)."""

    @abstractmethod
    def list_models(self) -> list[str]:
        """Models usable for this task (vision + tools + structured output), best guess first."""

    @abstractmethod
    def parse(self, system: str, parts: list[Part], schema: type[T]) -> T:
        """One request whose answer is validated against `schema`."""

    @abstractmethod
    def run_tools(
        self,
        system: str,
        parts: list[Part],
        tools: list[ToolSpec],
        stop: Callable[[], bool],
        max_turns: int = 15,
        on_tool: Optional[Callable[[str, dict], None]] = None,
    ) -> str:
        """Agent loop: let the model call tools until it stops or `stop()` is true. Returns last text."""


# ---------- Shared helpers ----------

def strict_schema(model: type[BaseModel]) -> dict:
    """JSON schema accepted by all three providers' strict tool modes: every field required,
    no extra properties, no titles."""
    schema = model.model_json_schema()

    def clean(node):
        if isinstance(node, dict):
            node.pop("title", None)
            node.pop("default", None)
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"])
            for v in node.values():
                clean(v)
        elif isinstance(node, list):
            for v in node:
                clean(v)

    clean(schema)
    return schema


def pick_latest(ids: list[str], pattern: str) -> list[str]:
    """Order model ids so the highest version matching `pattern` (one numeric group) comes first."""
    rx = re.compile(pattern)

    def key(mid: str):
        m = rx.match(mid)
        if not m:
            return (0, 0.0, mid)
        return (1, float(m.group(1)), mid)

    return sorted(ids, key=key, reverse=True)


PROVIDERS = {
    "anthropic": "Claude (Anthropic)",
    "openai": "ChatGPT (OpenAI)",
    "gemini": "Google Gemini",
}


def make_provider(creds: Credentials, model: Optional[str] = None) -> LLMProvider:
    if creds.provider == "anthropic":
        from .anthropic_llm import AnthropicProvider
        return AnthropicProvider(creds, model)
    if creds.provider == "openai":
        from .openai_llm import OpenAIProvider
        return OpenAIProvider(creds, model)
    if creds.provider == "gemini":
        from .gemini_llm import GeminiProvider
        return GeminiProvider(creds, model)
    raise ValueError(f"Unknown provider {creds.provider!r}")
