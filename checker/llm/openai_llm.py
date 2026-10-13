"""ChatGPT models via the OpenAI Responses API. Auth: API key only - OpenAI offers no sign-in that
third-party apps can use, and ChatGPT Plus/Pro subscriptions do not include API access."""

from __future__ import annotations

import base64
import json
from typing import Callable, Optional

import openai

from . import Credentials, Image, LLMError, LLMProvider, Pdf, Text, ToolSpec, pick_latest, strict_schema

_EXCLUDE = ("audio", "realtime", "tts", "transcribe", "embedding", "image", "search", "moderation",
            "instruct", "codex", "dall-e", "whisper", "babbage", "davinci", "sora", "computer")


class OpenAIProvider(LLMProvider):
    label = "ChatGPT (OpenAI)"

    def __init__(self, creds: Credentials, model: Optional[str] = None):
        super().__init__(creds, model)
        self._client = None
        self._reasoning_ok = True

    @property
    def client(self) -> openai.OpenAI:
        if self._client is None:
            self._client = openai.OpenAI(api_key=self.creds.api_key) if self.creds.api_key else openai.OpenAI()
        return self._client

    def check(self) -> tuple[bool, str]:
        try:
            n = len(self.list_models())
            return True, f"Connected to OpenAI ({n} chat models available)."
        except openai.AuthenticationError:
            return False, ("Invalid OpenAI API key (401). Create one at platform.openai.com -> API keys. "
                           "A ChatGPT Plus/Pro subscription does not include API access.")
        except openai.APIConnectionError as e:
            return False, f"Could not reach the OpenAI API: {e}"
        except openai.OpenAIError as e:  # e.g. no key at all
            return False, f"{e}"

    def list_models(self) -> list[str]:
        ids = [m.id for m in self.client.models.list()
               if m.id.startswith(("gpt-", "o")) and not any(x in m.id for x in _EXCLUDE)]
        # flagship "gpt-N(.M)" first, highest version wins
        return pick_latest(ids, r"gpt-(\d+(?:\.\d+)?)$")

    # ----- content -----
    @staticmethod
    def _item(p) -> dict:
        if isinstance(p, Text):
            return {"type": "input_text", "text": p.text}
        if isinstance(p, Pdf):
            return {"type": "input_file", "filename": p.filename,
                    "file_data": "data:application/pdf;base64," + base64.standard_b64encode(p.data).decode()}
        if isinstance(p, Image):
            return {"type": "input_image", "detail": "high",
                    "image_url": f"data:{p.media_type};base64," + base64.standard_b64encode(p.data).decode()}
        raise TypeError(p)

    def _with_reasoning(self, fn, effort: str, **kw):
        """Send a reasoning effort; models that don't support it get the request again without."""
        if self._reasoning_ok:
            try:
                return fn(reasoning={"effort": effort}, **kw)
            except openai.BadRequestError as e:
                if "reasoning" not in str(e).lower():
                    raise
                self._reasoning_ok = False
        return fn(**kw)

    def _require_model(self):
        if not self.model:
            raise LLMError("Select an OpenAI model first.")

    # ----- calls -----
    def parse(self, system, parts, schema):
        self._require_model()
        try:
            resp = self._with_reasoning(
                self.client.responses.parse, "medium", model=self.model, instructions=system,
                input=[{"role": "user", "content": [self._item(p) for p in parts]}],
                text_format=schema, max_output_tokens=16000,
            )
        except openai.AuthenticationError as e:
            raise LLMError("OpenAI rejected the API key (401).") from e
        if resp.output_parsed is None:
            raise LLMError(f"Incomplete answer from OpenAI (status={resp.status}).")
        return resp.output_parsed

    def run_tools(self, system, parts, tools: list[ToolSpec], stop: Callable[[], bool],
                  max_turns: int = 15, on_tool=None) -> str:
        self._require_model()
        by_name = {t.name: t for t in tools}
        api_tools = [{"type": "function", "name": t.name, "description": t.description,
                      "parameters": strict_schema(t.args), "strict": True} for t in tools]
        items: list = [{"role": "user", "content": [self._item(p) for p in parts]}]
        last_text = ""
        for _ in range(max_turns):
            resp = self._with_reasoning(
                self.client.responses.create, "high", model=self.model, instructions=system,
                input=items, tools=api_tools, max_output_tokens=32000,
            )
            items += [o.model_dump(exclude_none=True) for o in resp.output]
            outputs = []
            for o in resp.output:
                if o.type == "message":
                    text = "".join(c.text for c in o.content if getattr(c, "type", "") == "output_text")
                    if text.strip():
                        last_text = text
                elif o.type == "function_call":
                    outputs.append(self._run_tool(by_name, o, on_tool))
            if stop() or not outputs:
                return last_text
            items += outputs
        return last_text

    def _run_tool(self, by_name, call, on_tool) -> dict:
        try:
            args = json.loads(call.arguments or "{}")
            if on_tool:
                on_tool(call.name, args)
            tool = by_name[call.name]
            out = tool.handler(tool.args.model_validate(args))
        except Exception as e:
            out = f"ERROR: {e}"
        output = out if isinstance(out, str) else [self._item(p) for p in out]
        return {"type": "function_call_output", "call_id": call.call_id, "output": output}
