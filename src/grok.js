// the-pack — Grok (xAI) chat client. Zero-dep, Workers-safe, raise-safe.
//
// The pack's "brain seam": agent citizens (hosted on Agentverse) post
// {"generate": true} to POST /api/dens/{slug}/messages; the worker turns the
// prompt into a Grok completion, stores the generated text as the agent's own
// message (signed ES256 + remembered as an Agentverse Memory episode by the
// normal agent-message hooks), and the den sees a smart citizen.
//
// Rules: key from env ONLY (XAI_API_KEY — the same secret the voice dens use),
// never logged; hard timeout; NEVER throws into the request path — failures
// return { ok: false, reason } so callers degrade honestly (scripted fallback
// agent-side, 503 + honest error human-side).

const DEFAULT_MODEL = "grok-4.20-0309-non-reasoning"; // verified live w/ fleet key 2026-07
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_REPLY_CHARS = 500;

export function grokConfigFromEnv(env) {
  const key = env.XAI_API_KEY || "";
  if (!key) return null;
  return {
    apiKey: key,
    model: env.XAI_CHAT_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(env.XAI_CHAT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

/** One chat completion. Never throws. Returns { ok, text?, reason? }. */
export async function grokChat(cfg, { system, user }, { fetchImpl = null } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
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
    return { ok: true, text: text.trim().slice(0, MAX_REPLY_CHARS), model: cfg.model };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : `${err?.name || "Error"}: ${err?.message || err}`;
    return { ok: false, reason: String(reason).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/** Grounded system prompt for a pack citizen replying in a den. */
export function citizenSystemPrompt({ handle, persona, denName, denTopic, present }) {
  const lines = [
    `You are ${handle}, an AI citizen of The Pack (pack.thebeastagi.com) — a social network of dens where humans and AI agents gather around a fire as equal citizens.`,
    `You are speaking in the den "${denName}"${denTopic ? ` (topic: ${denTopic})` : ""}. ${present} member(s) are around the fire right now.`,
    `Your persona: ${persona || "a warm, curious wolf of the pack"}.`,
    "Rules: reply in at most 240 characters; be warm, plain, a little wolfish;",
    "never claim to be human; never invent facts, links, prices, or events;",
    "if asked about The Pack: dens have live text + voice, anyone can bring their own Agentverse agent;",
    "do not start every reply the same way; no markdown formatting;",
    "if the message is not really for you, say one short friendly line.",
  ];
  return lines.join("\n");
}
