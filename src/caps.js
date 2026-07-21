// the-pack — spend caps for paid Grok surfaces (live-search tools, /imagine).
// Robin's console is topped up in small amounts ($20 on 2026-07-21) so every
// paid path checks caps BEFORE the call and logs exact xAI cost after it.
//
// HARD FAIL CLOSED: when a cap is hit — or the usage ledger cannot be read —
// the paid call does not happen. Den brains degrade to a tools-off completion
// (no spend); /imagine refuses with an honest message. No path silently
// spends past a cap.
import { addBrainUsage, getBrainUsage, getGlobalBrainTicks } from "./db.js";

const TICKS_PER_USD = 10_000_000_000;

export function brainCapsFromEnv(env) {
  return {
    searchDen: Number(env.PACK_SEARCH_DEN_CAP) || 40, // tool calls / den / day (~$0.20)
    searchGlobal: Number(env.PACK_SEARCH_GLOBAL_CAP) || 600, // tool calls / day (~$3.00)
    imageDen: Number(env.PACK_IMAGE_DEN_CAP) || 15, // images / den / day (~$0.03)
    imageGlobal: Number(env.PACK_IMAGE_GLOBAL_CAP) || 300, // images / day (~$0.60)
    dailyUsdCap: Number(env.PACK_BRAIN_DAILY_USD_CAP) || 5.0, // hard ceiling across ALL brain spend
  };
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC day, same convention as voice_usage
}

/**
 * Pre-flight cap check for one paid call of `kind` ("search" | "image") in a
 * den. Returns { allowed, reason?, day, ... }. Fail CLOSED on any ledger
 * error — a missing ledger must never become free spend.
 */
export async function brainAllowed(env, denSlug, kind) {
  const caps = brainCapsFromEnv(env);
  const day = todayKey();
  try {
    const [denRow, globalRow, globalTicks] = await Promise.all([
      getBrainUsage(env.DB, day, denSlug, kind),
      getBrainUsage(env.DB, day, "*", kind),
      getGlobalBrainTicks(env.DB, day),
    ]);
    if (globalTicks >= caps.dailyUsdCap * TICKS_PER_USD) {
      return { allowed: false, reason: "daily_usd_cap", day, ticks: globalTicks };
    }
    const denCap = kind === "image" ? caps.imageDen : caps.searchDen;
    const globalCap = kind === "image" ? caps.imageGlobal : caps.searchGlobal;
    if (denRow.calls >= denCap) {
      return { allowed: false, reason: "den_cap", day, used: denRow.calls, cap: denCap };
    }
    if (globalRow.calls >= globalCap) {
      return { allowed: false, reason: "global_cap", day, used: globalRow.calls, cap: globalCap };
    }
    return { allowed: true, day, used: denRow.calls, cap: denCap };
  } catch {
    return { allowed: false, reason: "usage_read_failed", day };
  }
}

/**
 * Post-call usage logging. Raise-safe by design: a logged failure must never
 * break a reply that already happened (the NEXT pre-flight check failing
 * closed bounds the damage to one in-flight call).
 */
export async function logBrainUsage(env, denSlug, kind, calls, ticks) {
  try {
    const c = Number(calls) || 0;
    const t = Number(ticks) || 0;
    if (c <= 0 && t <= 0) return;
    await addBrainUsage(env.DB, todayKey(), denSlug, kind, c, t);
  } catch {}
}
