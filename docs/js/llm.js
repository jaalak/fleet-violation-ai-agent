// Browser-side LLM providers. Each one calls the vendor's REST API directly from the user's browser
// with the user's own key. Nothing is proxied.
//
// Neutral message parts:
//   {type:"text", text}            {type:"pdf", b64, name}            {type:"image", b64, mime}
// Tool:  {name, description, schema, handler(args) -> string | parts[]}

import { pickLatest } from "./util.js";

export const PROVIDERS = {
  anthropic: {
    label: "Claude (Anthropic)",
    keyHint: "sk-ant-api03-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keySite: "console.anthropic.com",
  },
  openai: {
    label: "ChatGPT (OpenAI)",
    keyHint: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    keySite: "platform.openai.com",
  },
  gemini: {
    label: "Google Gemini",
    keyHint: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    keySite: "aistudio.google.com (free tier available)",
  },
};

export class LLMError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function callJson(url, init, provider) {
  let resp;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    throw new LLMError(`Could not reach ${PROVIDERS[provider].label}: ${e.message}. Check your connection or ad-blocker.`);
  }
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!resp.ok) {
    const msg = body?.error?.message || body?.message || text.slice(0, 300) || resp.statusText;
    const p = PROVIDERS[provider];
    if (resp.status === 401 || (provider === "gemini" && /api key not valid/i.test(msg)))
      throw new LLMError(`${p.label} rejected the API key. Create one at ${p.keySite}. ` +
        "Chat subscriptions (Claude Pro, ChatGPT Plus, Gemini Advanced) don't include API access.", 401);
    if (resp.status === 429) throw new LLMError(`${p.label} rate limit or quota reached: ${msg}`, 429);
    throw new LLMError(`${p.label} error ${resp.status}: ${msg}`, resp.status);
  }
  return body;
}

export function makeProvider(id, apiKey, model) {
  const cls = { anthropic: AnthropicProvider, openai: OpenAIProvider, gemini: GeminiProvider }[id];
  if (!cls) throw new Error(`Unknown provider ${id}`);
  return new cls(apiKey, model);
}

// ---------------------------------------------------------------- Claude
const CLAUDE_DEFAULT = "claude-opus-5-5";

class AnthropicProvider {
  constructor(key, model) {
    this.id = "anthropic"; this.label = PROVIDERS.anthropic.label;
    this.key = key; this.model = model || CLAUDE_DEFAULT;
    this.fullFeatures = true; // adaptive thinking + effort + server-side refusal fallback
  }
  headers(beta) {
    const h = {
      "x-api-key": this.key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    };
    if (beta) h["anthropic-beta"] = "server-side-fallback-2026-07-01";
    return h;
  }
  async listModels() {
    const body = await callJson("https://api.anthropic.com/v1/models?limit=100", { headers: this.headers(false) }, this.id);
    const ids = (body.data || []).map((m) => m.id);
    const rest = pickLatest(ids.filter((i) => i !== CLAUDE_DEFAULT), /claude-opus-(\d+(?:-\d+)?)/);
    return (ids.includes(CLAUDE_DEFAULT) ? [CLAUDE_DEFAULT] : []).concat(rest);
  }
  block(p) {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.b64 } };
    if (p.type === "image") return { type: "image", source: { type: "base64", media_type: p.mime, data: p.b64 } };
    throw new Error("bad part");
  }
  /** Sends the full-featured request; if this model rejects one of those options, retries without them. */
  async send(body, effort) {
    if (this.fullFeatures) {
      try {
        return await callJson("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: this.headers(true),
          body: JSON.stringify({ ...body, thinking: { type: "adaptive" }, fallbacks: "default",
            output_config: { ...(body.output_config || {}), effort } }),
        }, this.id);
      } catch (e) {
        if (e.status !== 400 || !/thinking|effort|fallback|beta/i.test(e.message)) throw e;
        this.fullFeatures = false;
      }
    }
    return callJson("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: this.headers(false), body: JSON.stringify(body),
    }, this.id);
  }
  checkStop(r) {
    if (r.stop_reason === "refusal") throw new LLMError("Claude declined this request.");
  }
  async parse(system, parts, schema) {
    const r = await this.send({
      model: this.model, max_tokens: 16000, system,
      messages: [{ role: "user", content: parts.map((p) => this.block(p)) }],
      output_config: { format: { type: "json_schema", schema } },
    }, "medium");
    this.checkStop(r);
    const text = (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (r.stop_reason === "max_tokens") throw new LLMError("Claude's answer was cut off (max_tokens).");
    return JSON.parse(text);
  }
  async runTools(system, parts, tools, stop, onTool, maxTurns = 15) {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const apiTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema, strict: true }));
    const messages = [{ role: "user", content: parts.map((p) => this.block(p)) }];
    let lastText = "";
    for (let turn = 0; turn < maxTurns; turn++) {
      const r = await this.send({ model: this.model, max_tokens: 16000, system, tools: apiTools, messages }, "high");
      this.checkStop(r);
      messages.push({ role: "assistant", content: r.content });
      const results = [];
      for (const b of r.content || []) {
        if (b.type === "text" && b.text.trim()) lastText = b.text;
        if (b.type !== "tool_use") continue;
        onTool?.(b.name, b.input);
        try {
          const out = await byName[b.name].handler(b.input);
          const content = typeof out === "string" ? [{ type: "text", text: out }] : out.map((p) => this.block(p));
          results.push({ type: "tool_result", tool_use_id: b.id, content });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: String(e.message || e) });
        }
      }
      if (stop() || !results.length) return lastText;
      messages.push({ role: "user", content: results });
    }
    return lastText;
  }
}

// ---------------------------------------------------------------- OpenAI
const OPENAI_EXCLUDE = ["audio", "realtime", "tts", "transcribe", "embedding", "image", "search", "moderation",
  "instruct", "codex", "dall-e", "whisper", "babbage", "davinci", "sora", "computer"];

class OpenAIProvider {
  constructor(key, model) {
    this.id = "openai"; this.label = PROVIDERS.openai.label;
    this.key = key; this.model = model || "";
    this.reasoningOk = true;
  }
  headers() {
    return { authorization: `Bearer ${this.key}`, "content-type": "application/json" };
  }
  async listModels() {
    const body = await callJson("https://api.openai.com/v1/models", { headers: this.headers() }, this.id);
    const ids = (body.data || []).map((m) => m.id)
      .filter((id) => (id.startsWith("gpt-") || /^o\d/.test(id)) && !OPENAI_EXCLUDE.some((x) => id.includes(x)));
    return pickLatest(ids, /^gpt-(\d+(?:\.\d+)?)$/);
  }
  item(p) {
    if (p.type === "text") return { type: "input_text", text: p.text };
    if (p.type === "pdf") return { type: "input_file", filename: p.name || "document.pdf", file_data: `data:application/pdf;base64,${p.b64}` };
    if (p.type === "image") return { type: "input_image", detail: "high", image_url: `data:${p.mime};base64,${p.b64}` };
    throw new Error("bad part");
  }
  async send(body, effort) {
    const post = (b) => callJson("https://api.openai.com/v1/responses",
      { method: "POST", headers: this.headers(), body: JSON.stringify(b) }, this.id);
    if (this.reasoningOk) {
      try {
        return await post({ ...body, reasoning: { effort } });
      } catch (e) {
        if (e.status !== 400 || !/reasoning/i.test(e.message)) throw e;
        this.reasoningOk = false;
      }
    }
    return post(body);
  }
  static outputText(r) {
    let text = "";
    for (const o of r.output || []) {
      if (o.type !== "message") continue;
      for (const c of o.content || []) {
        if (c.type === "refusal") throw new LLMError(`OpenAI declined: ${c.refusal}`);
        if (c.type === "output_text") text += c.text;
      }
    }
    return text;
  }
  async parse(system, parts, schema, name = "result") {
    if (!this.model) throw new LLMError("Select an OpenAI model first.");
    const r = await this.send({
      model: this.model, instructions: system, max_output_tokens: 16000,
      input: [{ role: "user", content: parts.map((p) => this.item(p)) }],
      text: { format: { type: "json_schema", name, schema, strict: true } },
    }, "medium");
    if (r.status === "incomplete") throw new LLMError(`OpenAI answer incomplete: ${r.incomplete_details?.reason || ""}`);
    return JSON.parse(OpenAIProvider.outputText(r));
  }
  async runTools(system, parts, tools, stop, onTool, maxTurns = 15) {
    if (!this.model) throw new LLMError("Select an OpenAI model first.");
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const apiTools = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.schema, strict: true }));
    const items = [{ role: "user", content: parts.map((p) => this.item(p)) }];
    let lastText = "";
    for (let turn = 0; turn < maxTurns; turn++) {
      const r = await this.send({ model: this.model, instructions: system, input: items, tools: apiTools, max_output_tokens: 16000 }, "high");
      items.push(...(r.output || []));
      const t = OpenAIProvider.outputText(r);
      if (t.trim()) lastText = t;
      const outputs = [];
      for (const o of r.output || []) {
        if (o.type !== "function_call") continue;
        let out;
        try {
          const args = JSON.parse(o.arguments || "{}");
          onTool?.(o.name, args);
          out = await byName[o.name].handler(args);
        } catch (e) {
          out = `ERROR: ${e.message || e}`;
        }
        outputs.push({ type: "function_call_output", call_id: o.call_id,
          output: typeof out === "string" ? out : out.map((p) => this.item(p)) });
      }
      if (stop() || !outputs.length) return lastText;
      items.push(...outputs);
    }
    return lastText;
  }
}

// ---------------------------------------------------------------- Gemini
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

class GeminiProvider {
  constructor(key, model) {
    this.id = "gemini"; this.label = PROVIDERS.gemini.label;
    this.key = key; this.model = model || "";
  }
  headers() {
    return { "x-goog-api-key": this.key, "content-type": "application/json" };
  }
  async listModels() {
    const body = await callJson(`${GEMINI_BASE}/models?pageSize=1000`, { headers: this.headers() }, this.id);
    const ids = (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => n.includes("gemini") && !["embedding", "tts", "image", "live", "audio"].some((x) => n.includes(x)));
    return pickLatest([...new Set(ids)], /^gemini-(\d+(?:\.\d+)?)-pro/);
  }
  part(p) {
    if (p.type === "text") return { text: p.text };
    if (p.type === "pdf") return { inlineData: { mimeType: "application/pdf", data: p.b64 } };
    if (p.type === "image") return { inlineData: { mimeType: p.mime, data: p.b64 } };
    throw new Error("bad part");
  }
  async generate(body) {
    if (!this.model) throw new LLMError("Select a Gemini model first.");
    const r = await callJson(`${GEMINI_BASE}/models/${encodeURIComponent(this.model)}:generateContent`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, this.id);
    const cand = r.candidates?.[0];
    if (!cand?.content) {
      const why = r.promptFeedback?.blockReason || cand?.finishReason || "no content";
      throw new LLMError(`Gemini returned no answer (${why}).`);
    }
    return cand;
  }
  static text(cand) {
    return (cand.content.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
  }
  async parse(system, parts, schema) {
    const cand = await this.generate({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: parts.map((p) => this.part(p)) }],
      generationConfig: { maxOutputTokens: 16000, responseMimeType: "application/json", responseJsonSchema: schema },
    });
    if (cand.finishReason === "MAX_TOKENS") throw new LLMError("Gemini's answer was cut off (max tokens).");
    return JSON.parse(GeminiProvider.text(cand));
  }
  async runTools(system, parts, tools, stop, onTool, maxTurns = 15) {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const config = {
      systemInstruction: { parts: [{ text: system }] },
      tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema })) }],
      generationConfig: { maxOutputTokens: 16000 },
    };
    const contents = [{ role: "user", parts: parts.map((p) => this.part(p)) }];
    let lastText = "";
    for (let turn = 0; turn < maxTurns; turn++) {
      const cand = await this.generate({ ...config, contents });
      contents.push(cand.content); // unchanged, so thought signatures are preserved
      const t = GeminiProvider.text(cand);
      if (t.trim()) lastText = t;
      const calls = (cand.content.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall);
      const responseParts = [], imageParts = [];
      for (const fc of calls) {
        let response;
        try {
          onTool?.(fc.name, fc.args || {});
          const out = await byName[fc.name].handler(fc.args || {});
          if (typeof out === "string") response = { result: out };
          else {
            response = { result: "Image attached below." };
            imageParts.push(...out.filter((p) => p.type === "image").map((p) => this.part(p)));
          }
        } catch (e) {
          response = { error: String(e.message || e) };
        }
        responseParts.push({ functionResponse: { ...(fc.id && { id: fc.id }), name: fc.name, response } });
      }
      if (stop() || !responseParts.length) return lastText;
      contents.push({ role: "user", parts: [...responseParts, ...imageParts] });
    }
    return lastText;
  }
}
