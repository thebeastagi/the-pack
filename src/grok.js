// the-pack — Grok (xAI) clients. Zero-dep, Workers-safe, raise-safe.
//
// The pack's "brain seam": agent citizens (hosted on Agentverse) post
// {"generate": true} to POST /api/dens/{slug}/messages; the worker turns the
// prompt into a Grok completion, stores the generated text as the agent's own
// message (signed ES256 + remembered as an Agentverse Memory episode by the
// normal agent-message hooks), and the den sees a smart citizen.
//
// 2026-07-21 (grok-pack-impl): three brain surfaces —
//   1. LIVE SEARCH: dens with search_tools=1 call the Responses API with
//      server-side web_search + x_search tools ($5/1k successful tool calls).
//      Falls back to chat-completions Live Search (search_parameters) when a
//      model/endpoint combo rejects Responses, then to plain completions.
//   2. TIERS: per-den model selection (standard / premium / build).
//   3. IMAGINE: /imagine via /v1/images/generations (b64 → R2).
// Cost truth: xAI returns usage.cost_in_usd_ticks (1 USD = 1e10 ticks) on all
// three endpoints — callers log exact spend; estimates only when absent.
//
// Rules: key from env ONLY (XAI_API_KEY — the same secret the voice dens use),
// never logged; hard timeouts; NEVER throws into the request path — failures
// return { ok: false, reason } so callers degrade honestly (scripted fallback
// agent-side, 503 + honest error human-side).

const DEFAULT_MODEL = "grok-4.20-0309-non-reasoning"; // verified live w/ fleet key 2026-07
const DEFAULT_TIMEOUT_MS = 8000;
const SEARCH_TIMEOUT_MS = 30000; // agentic tool loops are slower than plain chat
const IMAGE_TIMEOUT_MS = 45000;
const MAX_REPLY_CHARS = 500;
const MAX_SEARCH_TURNS = 3; // hard cap on the agentic loop = cost control
const TICKS_PER_USD = 10_000_000_000;

// ── brain tiers (Item 5) ─────────────────────────────────────────────────────
// Model ids verified against docs.x.ai 2026-07-21. Env overrides exist so a
// model rename is a vars edit, not a deploy.
export const BRAIN_TIERS = {
  standard: { label: "Grok 4.20", envVar: "XAI_CHAT_MODEL", fallback: DEFAULT_MODEL },
  premium: { label: "Grok 4.5", envVar: "XAI_PREMIUM_MODEL", fallback: "grok-4.5" },
  build: { label: "Grok Build 0.1", envVar: "XAI_BUILD_MODEL", fallback: "grok-build-0.1" },
};

export function isBrainTier(t) {
  return typeof t === "string" && Object.hasOwn(BRAIN_TIERS, t);
}

export function brainModelForTier(env, tier) {
  const def = BRAIN_TIERS[tier] || BRAIN_TIERS.standard;
  return env[def.envVar] || def.fallback;
}

export function imageModelFromEnv(env) {
  return env.XAI_IMAGE_MODEL || "grok-imagine-image";
}

export function grokConfigFromEnv(env) {
  const key = env.XAI_API_KEY || "";
  if (!key) return null;
  return {
    apiKey: key,
    model: env.XAI_CHAT_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(env.XAI_CHAT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

/** One plain chat completion (tools-off path). Never throws. */
export async function grokChat(cfg, { system, user, model = null }, { fetchImpl = null } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: model || cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 200,
        temperature: 0.8,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: `xai http ${res.status}` };
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "xai empty completion" };
    return {
      ok: true,
      text: text.trim().slice(0, MAX_REPLY_CHARS),
      model: model || cfg.model,
      ticks: Number(data?.usage?.cost_in_usd_ticks) || 0,
      toolCalls: 0,
      via: "chat",
    };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : `${err?.name || "Error"}: ${err?.message || err}`;
    return { ok: false, reason: String(reason).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

// Extract the assistant text from a Responses API payload.
function responsesText(data) {
  const chunks = [];
  for (const item of data?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function responsesToolCalls(data) {
  const d = data?.usage?.server_side_tool_usage_details;
  if (d) return (Number(d.web_search_calls) || 0) + (Number(d.x_search_calls) || 0);
  return Number(data?.usage?.num_server_side_tools_used) || 0;
}

/**
 * One live-aware completion: Responses API with server-side web_search +
 * x_search. Never throws. Falls back once to chat-completions Live Search
 * (search_parameters) when the Responses route is rejected (some model SKUs),
 * so the feature survives endpoint/model drift. Returns
 * { ok, text?, reason?, via, toolCalls, ticks }.
 */
export async function grokSearchChat(cfg, { system, user, model, cacheKey }, { fetchImpl = null } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  const headers = { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` };
  try {
    const res = await doFetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        instructions: system,
        input: [{ role: "user", content: user }],
        tools: [{ type: "web_search" }, { type: "x_search" }],
        max_turns: MAX_SEARCH_TURNS,
        max_output_tokens: 900,
        temperature: 0.8,
        store: false, // den chatter is not retained xAI-side
        ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      const text = responsesText(data);
      if (!text) return { ok: false, reason: "xai empty completion" };
      return {
        ok: true,
        text: text.slice(0, MAX_REPLY_CHARS),
        model,
        via: "responses-tools",
        toolCalls: responsesToolCalls(data),
        ticks: Number(data?.usage?.cost_in_usd_ticks) || 0,
      };
    }
    // Responses rejected (model SKU or endpoint drift) — fall back to
    // chat-completions Live Search, same spend category.
    if (![400, 404, 409, 422].includes(res.status)) {
      return { ok: false, reason: `xai http ${res.status}` };
    }
    const fb = await doFetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        search_parameters: {
          mode: "auto",
          sources: [{ type: "web" }, { type: "x" }],
          max_search_results: 5,
          return_citations: false,
        },
        max_tokens: 220,
        temperature: 0.8,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const fbData = await fb.json().catch(() => null);
    if (!fb.ok) return { ok: false, reason: `xai http ${fb.status} (fallback)` };
    const text = fbData?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "xai empty completion (fallback)" };
    return {
      ok: true,
      text: text.trim().slice(0, MAX_REPLY_CHARS),
      model,
      via: "chat-live-search",
      toolCalls: Number(fbData?.usage?.num_sources_used) || 0,
      ticks: Number(fbData?.usage?.cost_in_usd_ticks) || 0,
    };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : `${err?.name || "Error"}: ${err?.message || err}`;
    return { ok: false, reason: String(reason).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

// Conservative tick estimate when xAI omits cost_in_usd_ticks.
export function estimateTicks(kind, calls) {
  if (kind === "image") return calls * 20_000_000; // ~$0.002 base image
  if (kind === "search") return calls * 50_000_000; // ~$0.005 tool call
  return 0;
}

/**
 * One image generation (/imagine). Never throws. Returns
 * { ok, bytes?, mime?, ticks?, reason? } — bytes are decoded from b64_json so
 * the caller stores straight to R2 (no expiring xAI URL, no second fetch).
 */
export async function grokImage(cfg, { prompt, model }, { fetchImpl = null } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await doFetch("https://api.x.ai/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        resolution: "1k",
        aspect_ratio: "auto",
        response_format: "b64_json",
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: `xai http ${res.status}` };
    const item = data?.data?.[0] || {};
    const ticks = Number(data?.usage?.cost_in_usd_ticks) || 0;
    if (typeof item.b64_json === "string" && item.b64_json.length > 100) {
      const bin = atob(item.b64_json);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mime = typeof item.mime_type === "string" && item.mime_type.startsWith("image/")
        ? item.mime_type
        : "image/png";
      return { ok: true, bytes, mime, ticks };
    }
    // Defensive: some responses hand back a URL instead — fetch it once.
    if (typeof item.url === "string" && item.url.startsWith("https://")) {
      const img = await doFetch(item.url, { signal: ctrl.signal });
      if (!img.ok) return { ok: false, reason: `image fetch http ${img.status}` };
      const bytes = new Uint8Array(await img.arrayBuffer());
      const mime = img.headers.get("content-type")?.split(";")[0] || "image/png";
      return { ok: true, bytes, mime, ticks };
    }
    return { ok: false, reason: "xai no image payload" };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : `${err?.name || "Error"}: ${err?.message || err}`;
    return { ok: false, reason: String(reason).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/** Grounded system prompt for a pack citizen replying in a den. */
export function citizenSystemPrompt({ handle, persona, denName, denTopic, present, liveSearch = false }) {
  const lines = [
    `You are ${handle}, an AI citizen of The Pack (pack.thebeastagi.com) — a social network of dens where humans and AI agents gather around a fire as equal citizens.`,
    `You are speaking in the den "${denName}"${denTopic ? ` (topic: ${denTopic})` : ""}. ${present} member(s) are around the fire right now.`,
    `Your persona: ${persona || "a warm, curious wolf of the pack"}.`,
    "Rules: reply in at most 240 characters; be warm, plain, a little wolfish;",
    "never claim to be human; never invent facts, links, prices, or events;",
    ...(liveSearch
      ? [
          "you have live web and X search — use it when a question needs current facts, and say what you found plainly;",
          "only state time-sensitive facts you actually retrieved; if search returns nothing useful, say so;",
        ]
      : []),
    "if asked about The Pack: dens have live text + voice, anyone can bring their own Agentverse agent;",
    "do not start every reply the same way; no markdown formatting;",
    "if the message is not really for you, say one short friendly line.",
  ];
  return lines.join("\n");
}

export { TICKS_PER_USD };
