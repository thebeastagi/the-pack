// the-pack — pack episode recorder: Agentverse Memory write + provenance sig.
//
// One helper for every "something worth remembering happened in a den" hook
// (den created, agent message, voice session end, admin digest). It builds a
// canonical record, signs it (ES256, src/aevs.js), and stores it as an
// Agentverse Memory episode tagged `den:{slug}` so any Beast agent — and the
// pack's own /api/dens/{slug}/memory endpoint — can recall per-den history.
//
// NEVER throws, NEVER blocks the caller's response: callers pass ctx so the
// write rides on waitUntil; without ctx the promise is fired and forgotten.

import { memoryConfigFromEnv, storeEpisode } from "./memory.js";
import { signRecord } from "./aevs.js";

export function buildEpisodeRecord(kind, denSlug, summary) {
  return {
    platform: "the-pack",
    v: 1,
    kind,
    den: `den:${denSlug}`,
    summary: String(summary).slice(0, 800),
    ts: new Date().toISOString(),
  };
}

export function episodeContent(record, signature) {
  const head = `[the-pack] ${record.den} ${record.kind} — ${record.summary} (${record.ts})`;
  if (!signature) return head;
  return `${head}\nprovenance: ${signature.alg}/${signature.kid}/${signature.sig}`;
}

/**
 * Record one pack episode. Returns a promise resolving to a result object;
 * when ctx is given the promise is also registered with ctx.waitUntil.
 * Result: { memory: "unconfigured"|"stored"|"unavailable", signed: bool, ... }
 */
export function recordPackEpisode(env, ctx, kind, denSlug, summary, { fetchImpl = null } = {}) {
  const work = (async () => {
    const record = buildEpisodeRecord(kind, denSlug, summary);
    const signature = await signRecord(env, record).catch(() => null);
    const cfg = memoryConfigFromEnv(env);
    if (!cfg) return { memory: "unconfigured", signed: Boolean(signature), record, signature };
    const out = await storeEpisode(cfg, episodeContent(record, signature), { fetchImpl });
    return {
      memory: out.available ? "stored" : "unavailable",
      reason: out.reason,
      episodeId: out.id ?? null,
      signed: Boolean(signature),
      record,
      signature,
    };
  })().catch((err) => ({ memory: "error", reason: String(err).slice(0, 120), signed: false }));
  if (ctx?.waitUntil) ctx.waitUntil(work);
  return work;
}
