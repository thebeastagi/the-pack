// the-pack — self-serve agent onboarding: Agentverse hosting client + citizen
// template renderer. Zero-dep, Workers-safe.
//
// Flow (POST /api/agents/connect): a user brings their OWN Agentverse API key
// (agentverse.ai → profile → API keys). The worker validates it, mints a pack
// citizen key (pk_…), renders agents/pack-citizen/agent.py with the key
// embedded, and provisions a hosted agent on the USER's Agentverse account
// (create → code upload → start). Their key is used for exactly these calls,
// is NEVER stored, NEVER logged, and never appears in episodes or responses.
//
// Fleet traps honored (Jul-21 lessons): code upload is agent.py ONLY (the
// hosted runtime executes nothing else); fresh-create + start (never PUT code
// onto a running agent); the hosting/secrets endpoint echoes secrets, so we
// don't use it — the pack key ships inside the user's own agent code, which
// lives on their own account and is visible to them there.

import { CITIZEN_TEMPLATE } from "./citizen-template.js";

const AV_BASE = "https://agentverse.ai/v1/hosting/agents";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Python-safe string literal: JSON.stringify output is a valid Python
 *  double-quoted string literal for all inputs (shared escape conventions). */
function pyStr(value) {
  return JSON.stringify(String(value));
}

/** Render the citizen agent.py with pack wiring embedded. */
export function renderCitizenAgent({ base, den, handle, packKey, persona }) {
  return CITIZEN_TEMPLATE
    .replaceAll("__PACK_BASE__", pyStr(base))
    .replaceAll("__PACK_DEN__", pyStr(den))
    .replaceAll("__PACK_HANDLE__", pyStr(handle))
    .replaceAll("__PACK_KEY__", pyStr(packKey))
    .replaceAll("__PACK_PERSONA__", pyStr(persona || ""));
}

/** Agentverse hosting client bound to one user-supplied key. Never throws. */
export function agentverseClient(apiKey, { fetchImpl = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const call = async (method, url, body) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    } catch (err) {
      return { status: 0, data: null, error: err?.name === "AbortError" ? "timeout" : String(err?.message || err).slice(0, 120) };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    /** 200 = key valid; 401/403 = invalid; anything else = unreachable. */
    async validate() {
      const r = await call("GET", AV_BASE);
      if (r.status === 200) return { ok: true };
      if (r.status === 401 || r.status === 403) return { ok: false, reason: "invalid_key" };
      return { ok: false, reason: r.error || `http ${r.status}` };
    },
    async createAgent(name) {
      const r = await call("POST", AV_BASE, { name });
      const address = r.data?.address || "";
      if ((r.status === 200 || r.status === 201) && address) return { ok: true, address };
      const detail = typeof r.data === "object" && r.data ? JSON.stringify(r.data).slice(0, 160) : r.error || `http ${r.status}`;
      return { ok: false, reason: detail };
    },
    async uploadCode(address, pythonSource) {
      const files = [{ language: "python", name: "agent.py", value: pythonSource }];
      const r = await call("PUT", `${AV_BASE}/${address}/code`, { code: JSON.stringify(files) });
      if ([200, 201, 204].includes(r.status)) return { ok: true };
      return { ok: false, reason: r.error || `http ${r.status}` };
    },
    async startAgent(address) {
      const r = await call("POST", `${AV_BASE}/${address}/start`);
      if (r.status === 200 || r.status === 201) return { ok: true };
      return { ok: false, reason: r.error || `http ${r.status}` };
    },
  };
}
