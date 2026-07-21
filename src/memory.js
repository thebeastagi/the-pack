// the-pack — Agentverse Memory client (zero-dep, Workers-safe).
//
// Talks to the fleet's Agentverse Memory MCP service (JSON-RPC 2.0 over
// HTTPS), the same service the fleet's Python memory_client.py uses
// (voice-bridge v4). Episodes are stored under the fleet operator's memory
// namespace (AM_AGENT_ID must match the API key's owner — the server rejects
// mismatches) with source "the-pack", so den history is recallable by every
// Beast agent and queryable per-den via the `den:{slug}` tag.
//
// Rules (mirrored from the Python client):
//   * credentials come from env ONLY, are never logged and never persisted;
//   * every call has a hard timeout and NEVER throws into the request path —
//     failures return { available: false, reason } so the platform degrades
//     honestly (health/features report what is actually configured).

const DEFAULT_TIMEOUT_MS = 3000;

/** Build config from worker env; null when memory is not configured. */
export function memoryConfigFromEnv(env) {
  const base = (env.AM_BASE_URL || (env.AM_API_URL || "").replace(/\/mcp\/?$/, "")).replace(/\/+$/, "");
  const key = env.AM_API_KEY || "";
  if (!base || !key) return null;
  return {
    baseUrl: base,
    apiKey: key,
    agentId: env.AM_AGENT_ID || "beast-engineer",
    timeoutMs: Number(env.AM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

function unwrapMcp(rpc) {
  if (!rpc || typeof rpc !== "object") throw new Error("non-dict rpc response");
  if (rpc.error) throw new Error(`rpc error ${rpc.error.code ?? "?"}`);
  const result = rpc.result ?? {};
  if (result.isError) {
    const sc = result.structuredContent || {};
    throw new Error(`tool error: ${sc.error || "unknown"}`);
  }
  if ("structuredContent" in result) return result.structuredContent;
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return typeof result === "object" ? result : {};
  }
}

/** One MCP tools/call against the memory service. Never throws. */
async function mcpCall(cfg, tool, args, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch(`${cfg.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: ctrl.signal,
    });
    const rpc = await res.json().catch(() => null);
    if (!res.ok) return { available: false, reason: `http ${res.status}` };
    return unwrapMcp(rpc);
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : `${err?.name || "Error"}: ${err?.message || err}`;
    return { available: false, reason: String(reason).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

/** Write one episode. Never throws. */
export async function storeEpisode(cfg, content, { source = "the-pack", sessionId = null, fetchImpl = null } = {}) {
  const args = { agent_id: cfg.agentId, content, source };
  if (sessionId) args.session_id = sessionId;
  const out = await mcpCall(cfg, "memory_store_episode", args, fetchImpl);
  if (out?.available === false) return out;
  return { available: true, stored: out.stored !== false, id: out.id ?? null };
}

/** Semantic search over episodes (per-den recall via `den:{slug}` queries). */
export async function searchEpisodes(cfg, query, limit = 5, { fetchImpl = null } = {}) {
  const out = await mcpCall(
    cfg,
    "memory_search_episodes",
    { agent_id: cfg.agentId, query, limit },
    fetchImpl,
  );
  if (out?.available === false) return out;
  const results = (out.results || []).slice(0, limit).map((r) => {
    const ep = r.episode || {};
    return {
      content: String(ep.content || "").slice(0, 600),
      score: r.score ?? null,
      created_at: ep.created_at ?? null,
    };
  });
  return { available: true, agent_id: cfg.agentId, count: results.length, results };
}
