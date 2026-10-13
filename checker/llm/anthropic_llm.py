"""Claude via the Anthropic SDK. Auth: API key, or a signed-in Anthropic Console profile (`ant auth login`)."""

from __future__ import annotations

import base64

from typing import Callable, Optional

import anthropic

from . import Credentials, Image, LLMError, LLMProvider, Pdf, Text, ToolSpec, pick_latest, strict_schema

FALLBACK_BETA = "server-side-fallback-2026-07-01"
DEFAULT_MODEL = "claude-opus-5-5"


class AnthropicProvider(LLMProvider):
    label = "Claude (Anthropic)"

    def __init__(self, creds: Credentials, model: Optional[str] = None):
        super().__init__(creds, model or DEFAULT_MODEL)
        self._client = None

    @property
    def client(self) -> anthropic.Anthropic:
        if self._client is None:
            if self.creds.method == "account":
                # An explicit profile makes the SDK ignore ANTHROPIC_API_KEY in the environment.
                self._client = anthropic.Anthropic(profile=self.creds.profile or "default")
            elif self.creds.api_key:
                self._client = anthropic.Anthropic(api_key=self.creds.api_key)
            else:
                self._client = anthropic.Anthropic()  # environment variables
        return self._client

    # ----- auth -----
    def check(self) -> tuple[bool, str]:
        if self.creds.api_key and "..." in self.creds.api_key:
            return False, "That is the placeholder 'sk-ant-...'. Paste your real key."
        try:
            n = len(self.list_models())
            return True, f"Connected to Anthropic ({n} models available)."
        except anthropic.AuthenticationError:
            return False, ("Invalid Anthropic credentials (401). Create a key at console.anthropic.com -> "
                           "Settings -> API Keys (starts with 'sk-ant-api03-'). Claude.ai / Claude Code "
                           "subscriptions do not include API access.")
        except anthropic.PermissionDeniedError as e:
            return False, f"Permission denied: {e.message}"
        except anthropic.APIConnectionError as e:
            return False, f"Could not reach the Anthropic API: {e}"
        except anthropic.AnthropicError as e:  # e.g. missing / expired profile, no key configured
            if self.creds.method == "account":
                return False, (f"No signed-in Anthropic account found (profile '{self.creds.profile or 'default'}'). "
                               "Run `ant auth login` in a terminal on this computer, then click Connect again.")
            return False, f"{e}"

    def list_models(self) -> list[str]:
        ids = [m.id for m in self.client.models.list(limit=100)]
        ordered = pick_latest(ids, r"claude-opus-(\d+(?:-\d+)?)")
        return ([DEFAULT_MODEL] if DEFAULT_MODEL in ids else []) + [i for i in ordered if i != DEFAULT_MODEL]

    # ----- content -----
    @staticmethod
    def _block(p) -> dict:
        if isinstance(p, Text):
            return {"type": "text", "text": p.text}
        if isinstance(p, Pdf):
            return {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                   "data": base64.standard_b64encode(p.data).decode()}}
        if isinstance(p, Image):
            return {"type": "image", "source": {"type": "base64", "media_type": p.media_type,
                                                "data": base64.standard_b64encode(p.data).decode()}}
        raise TypeError(p)

    def _common(self) -> dict:
        return dict(model=self.model, thinking={"type": "adaptive"},
                    betas=[FALLBACK_BETA], fallbacks="default")

    @staticmethod
    def _check_stop(resp) -> None:
        if resp.stop_reason == "refusal":
            raise LLMError("Claude declined this request.")

    # ----- calls -----
    def parse(self, system, parts, schema):
        try:
            resp = self.client.beta.messages.parse(
                **self._common(), max_tokens=16000, output_config={"effort": "medium"}, system=system,
                messages=[{"role": "user", "content": [self._block(p) for p in parts]}],
                output_format=schema,
            )
        except anthropic.AuthenticationError as e:
            raise LLMError("Anthropic rejected the credentials (401).") from e
        self._check_stop(resp)
        if resp.parsed_output is None:
            raise LLMError(f"Incomplete answer (stop_reason={resp.stop_reason}).")
        return resp.parsed_output

    def run_tools(self, system, parts, tools: list[ToolSpec], stop: Callable[[], bool],
                  max_turns: int = 15, on_tool=None) -> str:
        by_name = {t.name: t for t in tools}
        api_tools = [{"name": t.name, "description": t.description, "strict": True,
                      "input_schema": strict_schema(t.args)} for t in tools]
        messages = [{"role": "user", "content": [self._block(p) for p in parts]}]
        last_text = ""
        for _ in range(max_turns):
            # streamed: large max_tokens + thinking can exceed the SDK's non-streaming time limit
            with self.client.beta.messages.stream(
                **self._common(), max_tokens=32000, output_config={"effort": "high"},
                system=system, tools=api_tools, messages=messages,
            ) as stream:
                resp = stream.get_final_message()
            self._check_stop(resp)
            messages.append({"role": "assistant", "content": resp.content})
            results = []
            for block in resp.content:
                if block.type == "text" and block.text.strip():
                    last_text = block.text
                elif block.type == "tool_use":
                    results.append(self._run_tool(by_name, block, on_tool))
            if stop() or not results:
                return last_text
            messages.append({"role": "user", "content": results})
        return last_text

    def _run_tool(self, by_name, block, on_tool) -> dict:
        if on_tool:
            on_tool(block.name, block.input)
        tool = by_name.get(block.name)
        try:
            if tool is None:
                raise ValueError(f"Unknown tool {block.name}")
            out = tool.handler(tool.args.model_validate(block.input))
        except Exception as e:  # tell the model, let it recover
            return {"type": "tool_result", "tool_use_id": block.id, "is_error": True, "content": str(e)}
        content = [{"type": "text", "text": out}] if isinstance(out, str) else [self._block(p) for p in out]
        return {"type": "tool_result", "tool_use_id": block.id, "content": content}


