"""Google Gemini via the google-genai SDK.

Auth: an API key from Google AI Studio, or a Google account through Vertex AI
(Application Default Credentials: `gcloud auth application-default login`)."""

from __future__ import annotations

import json
from typing import Callable, Optional

from google import genai
from google.genai import errors, types

from . import Credentials, Image, LLMError, LLMProvider, Pdf, Text, ToolSpec, pick_latest, strict_schema


class GeminiProvider(LLMProvider):
    label = "Google Gemini"

    def __init__(self, creds: Credentials, model: Optional[str] = None):
        super().__init__(creds, model)
        self._client = None

    @property
    def client(self) -> genai.Client:
        if self._client is None:
            if self.creds.method == "account":
                if not self.creds.project:
                    raise LLMError("Enter your Google Cloud project ID to use your Google account.")
                self._client = genai.Client(vertexai=True, project=self.creds.project,
                                            location=self.creds.location or "global")
            elif self.creds.api_key:
                self._client = genai.Client(api_key=self.creds.api_key)
            else:
                self._client = genai.Client()  # GEMINI_API_KEY / GOOGLE_API_KEY
        return self._client

    def check(self) -> tuple[bool, str]:
        try:
            n = len(self.list_models())
            where = f"Vertex AI project {self.creds.project}" if self.creds.method == "account" else "Gemini API"
            return True, f"Connected to {where} ({n} Gemini models available)."
        except errors.ClientError as e:
            if e.code in (400, 401, 403):
                return False, ("Google rejected the credentials. For an API key, create one at "
                               "aistudio.google.com -> Get API key. For a Google account, run "
                               "`gcloud auth application-default login` and enable Vertex AI on the project. "
                               f"({e.code}: {e.message})")
            return False, f"{e.code}: {e.message}"
        except Exception as e:  # google.auth DefaultCredentialsError, network, missing key...
            msg = str(e)
            if "default credentials" in msg.lower():
                msg += " - run `gcloud auth application-default login` in a terminal, then try again."
            return False, msg

    def list_models(self) -> list[str]:
        ids = []
        for m in self.client.models.list():
            name = (m.name or "").split("/")[-1]
            actions = getattr(m, "supported_actions", None) or []
            if "gemini" in name and ("generateContent" in actions or not actions) \
                    and not any(x in name for x in ("embedding", "tts", "image", "live", "audio")):
                ids.append(name)
        # prefer the highest-version "pro", then everything else
        return pick_latest(sorted(set(ids)), r"gemini-(\d+(?:\.\d+)?)-pro")

    # ----- content -----
    @staticmethod
    def _part(p) -> types.Part:
        if isinstance(p, Text):
            return types.Part.from_text(text=p.text)
        if isinstance(p, Pdf):
            return types.Part.from_bytes(data=p.data, mime_type="application/pdf")
        if isinstance(p, Image):
            return types.Part.from_bytes(data=p.data, mime_type=p.media_type)
        raise TypeError(p)

    def _require_model(self):
        if not self.model:
            raise LLMError("Select a Gemini model first.")

    @staticmethod
    def _check_blocked(resp) -> None:
        if not resp.candidates:
            reason = getattr(getattr(resp, "prompt_feedback", None), "block_reason", None)
            raise LLMError(f"Gemini returned no answer (blocked: {reason}).")

    # ----- calls -----
    def parse(self, system, parts, schema):
        self._require_model()
        resp = self.client.models.generate_content(
            model=self.model,
            contents=[types.Content(role="user", parts=[self._part(p) for p in parts])],
            config=types.GenerateContentConfig(
                system_instruction=system, max_output_tokens=16000,
                response_mime_type="application/json", response_json_schema=schema.model_json_schema(),
            ),
        )
        self._check_blocked(resp)
        try:
            return schema.model_validate_json(resp.text or "")
        except ValueError as e:
            raise LLMError(f"Gemini returned invalid JSON: {e}") from e

    def run_tools(self, system, parts, tools: list[ToolSpec], stop: Callable[[], bool],
                  max_turns: int = 15, on_tool=None) -> str:
        self._require_model()
        by_name = {t.name: t for t in tools}
        config = types.GenerateContentConfig(
            system_instruction=system, max_output_tokens=32000,
            tools=[types.Tool(function_declarations=[
                types.FunctionDeclaration(name=t.name, description=t.description,
                                          parameters_json_schema=strict_schema(t.args))
                for t in tools])],
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
        contents = [types.Content(role="user", parts=[self._part(p) for p in parts])]
        last_text = ""
        for _ in range(max_turns):
            resp = self.client.models.generate_content(model=self.model, contents=contents, config=config)
            self._check_blocked(resp)
            contents.append(resp.candidates[0].content)
            text = "".join(p.text for p in (resp.candidates[0].content.parts or []) if p.text and not p.thought)
            if text.strip():
                last_text = text
            calls = resp.function_calls or []
            responses = [self._run_tool(by_name, fc, on_tool) for fc in calls]
            if stop() or not responses:
                return last_text
            contents.append(types.Content(role="user", parts=responses))
        return last_text

    def _run_tool(self, by_name, fc, on_tool) -> types.Part:
        args = dict(fc.args or {})
        if on_tool:
            on_tool(fc.name, args)
        extra_parts = None
        try:
            tool = by_name[fc.name]
            out = tool.handler(tool.args.model_validate(args))
            if isinstance(out, str):
                result = {"result": out}
            else:
                result = {"result": " ".join(p.text for p in out if isinstance(p, Text)) or "image attached"}
                extra_parts = [types.FunctionResponsePart.from_bytes(data=p.data, mime_type=p.media_type)
                               for p in out if isinstance(p, Image)] or None
        except Exception as e:
            result = {"error": str(e)}
        return types.Part(function_response=types.FunctionResponse(
            id=fc.id, name=fc.name, response=json.loads(json.dumps(result)), parts=extra_parts))
