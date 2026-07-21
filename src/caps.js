// the-pack — spend caps for paid Grok surfaces (live-search tools, /imagine,
// RAG file_search, voice). Robin's console is topped up in small amounts ($20
// on 2026-07-21) so every paid path checks caps BEFORE the call and logs
// exact xAI cost after it.
//
// Phase 1 monetisation (2026-07-21, pack-monetisation-plan §4) adds a
// TWO-LAYER cap model:
//   * HARD infrastructure ceilings (existing PACK_* vars) protect OUR spend.
//     Nobody goes past them, paying or not: daily_usd_cap, den_hard_cap,
//     global_hard_cap, usage_read_failed are absolute refusals.
//   * FREE-pool allowances (PACK_FREE_* vars) are what non-paying use gets.
//     When a den exhausts its free pool (den_cap / global_cap), the caller's
//     own credits may pay for the call (brainAllowedOrBurn → atomicDebit).
//     Only kinds with a burn floor (search, image) can burn — rag/voice have
//     no phase-1 burn path.
//
// HARD FAIL CLOSED: when a cap is hit — or the usage ledger cannot be read —
// the paid call does not happen. Den brains degrade to a tools-off completion
// (no spend); /imagine refuses with an honest message. No path silently
// spends past a cap, and no credit is burned without a guarded atomic debit.
import { addBrainUsage, getBrainUsage, getGlobalBrainTicks } from "./db.js";
import { atomicDebit, burnQuote, BURN_FLOORS } from "./credits.js";

const TICKS_PER_USD = 10_000_000_000;

// Free-pool vars respect an explicit "0" (a real ops kill-switch: zero free
// allowance = everything paid) — unlike the legacy hard-cap vars, which keep
// their `|| default` semantics for back-compat.
function freeNum(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

export function brainCapsFromEnv(env) {
  return {
    // FREE pool (burn falls through past these) — plan §2.1
    freeSearchDen: freeNum(env.PACK_FREE_SEARCH_DEN_CAP, 20), // tool calls / den / day (was 40)
    freeImageDen: freeNum(env.PACK_FREE_IMAGE_DEN_CAP, 3), // images / den / day (was 15)
    freeDailyUsd: freeNum(env.PACK_FREE_DAILY_USD_CAP, 2.0), // global free-spend fuse (was $5)
    // HARD infrastructure ceilings (absolute for everyone) — existing vars
    searchDen: Number(env.PACK_SEARCH_DEN_CAP) || 40, // tool calls / den / day (~$0.20)
    searchGlobal: Number(env.PACK_SEARCH_GLOBAL_CAP) || 600, // tool calls / day (~$3.00)
    imageDen: Number(env.PACK_IMAGE_DEN_CAP) || 15, // images / den / day (~$0.03)
    imageGlobal: Number(env.PACK_IMAGE_GLOBAL_CAP) || 300, // images / day (~$0.60)
    ragDen: Number(env.PACK_RAG_DEN_CAP) || 30, // file_search calls / den / day (~$0.08)
    ragGlobal: Number(env.PACK_RAG_GLOBAL_CAP) || 200, // file_search calls / day (~$0.50)
    dailyUsdCap: Number(env.PACK_BRAIN_DAILY_USD_CAP) || 5.0, // hard ceiling across ALL brain spend
  };
}

// Per-kind HARD den/global count ceilings. 'chat' + 'voice' have no count
// caps (the USD ceiling is their binding guard) — they are never pre-flighted
// here.
const KIND_CAPS = {
  search: (c) => [c.searchDen, c.searchGlobal],
  image: (c) => [c.imageDen, c.imageGlobal],
  rag: (c) => [c.ragDen, c.ragGlobal],
};

// Per-kind FREE per-den allowance. RAG has no phase-1 free pool distinct from
// its hard cap (and no burn floor) — denials there never trigger a burn.
const KIND_FREE_DEN = {
  search: (c) => Math.min(c.freeSearchDen, c.searchDen),
  image: (c) => Math.min(c.freeImageDen, c.imageDen),
  rag: (c) => c.ragDen,
};

export function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC day, same convention as voice_usage
}

/**
 * Pre-flight check for one paid call of `kind` ("search" | "image" | "rag")
 * in a den.
 *
 * With userId=null this is the FREE-only check (legacy brainAllowed
 * semantics): allowed iff under the free pool AND the hard ceilings.
 *
 * With a userId, a free-pool denial (den_cap/global_cap) attempts a credit
 * burn of the surface's flat floor rate; success → { allowed:true, paid:true,
 * burned, balance } and the call proceeds. Hard-ceiling denials
 * (daily_usd_cap, den_hard_cap, global_hard_cap) and ledger failures
 * (usage_read_failed) NEVER burn — they refuse outright.
 *
 * Fail CLOSED on any ledger error AND on any debit error — a missing ledger
 * must never become free spend, and a broken credit store must never become
 * a free paid call.
 */
export async function brainAllowedOrBurn(env, denSlug, kind, userId = null) {
  const caps = brainCapsFromEnv(env);
  const day = todayKey();
  let denRow, globalRow, globalTicks;
  try {
    [denRow, globalRow, globalTicks] = await Promise.all([
      getBrainUsage(env.DB, day, denSlug, kind),
      getBrainUsage(env.DB, day, "*", kind),
      getGlobalBrainTicks(env.DB, day),
    ]);
  } catch {
    return { allowed: false, reason: "usage_read_failed", day };
  }

  // 1. HARD absolute ceilings — payment never overrides these (plan §5).
  if (globalTicks >= caps.dailyUsdCap * TICKS_PER_USD) {
    return { allowed: false, reason: "daily_usd_cap", day, ticks: globalTicks };
  }
  const [hardDen, hardGlobal] = (KIND_CAPS[kind] || KIND_CAPS.search)(caps);
  if (denRow.calls >= hardDen) {
    return { allowed: false, reason: "den_hard_cap", day, used: denRow.calls, cap: hardDen };
  }
  if (globalRow.calls >= hardGlobal) {
    return { allowed: false, reason: "global_hard_cap", day, used: globalRow.calls, cap: hardGlobal };
  }

  // 2. FREE pool — a credit burn may override a denial here (only for kinds
  //    with a burn floor; rag falls through to a plain denial).
  const freeDen = (KIND_FREE_DEN[kind] || KIND_FREE_DEN.search)(caps);
  const freeUsd = Math.min(caps.freeDailyUsd, caps.dailyUsdCap);
  let denial = null;
  if (denRow.calls >= freeDen) {
    denial = { reason: "den_cap", used: denRow.calls, cap: freeDen };
  } else if (globalTicks >= freeUsd * TICKS_PER_USD) {
    denial = { reason: "global_cap", day, ticks: globalTicks, capUsd: freeUsd };
  }
  if (!denial) return { allowed: true, paid: false, day, used: denRow.calls, cap: freeDen };

  if (!userId || BURN_FLOORS[kind] == null) return { allowed: false, ...denial, day };
  const quote = burnQuote(env, kind, 0); // flat floor — exact ticks unknown pre-call
  let debit;
  try {
    debit = await atomicDebit(env.DB, userId, quote, `burn:${kind}`, denSlug);
  } catch {
    return { allowed: false, reason: "usage_read_failed", day }; // fail closed, symmetric
  }
  if (!debit.ok) {
    return { allowed: false, ...denial, day, insufficient: true, balance: debit.balance, burn: quote };
  }
  return { allowed: true, paid: true, burned: quote, balance: debit.balanceAfter, via: denial.reason, day };
}

/**
 * Legacy free-only pre-flight check (no burn). Kept for callers without a
 * payer identity and for the admin readout's shape compatibility.
 */
export async function brainAllowed(env, denSlug, kind) {
  return brainAllowedOrBurn(env, denSlug, kind, null);
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

/**
 * Voice session pre-flight (wave 2): voice spend lives UNDER the same daily
 * USD ceiling as every other brain surface. Fail CLOSED — a ledger that
 * cannot be read must never become unmetered voice minutes.
 */
export async function voiceAllowed(env) {
  const caps = brainCapsFromEnv(env);
  try {
    const ticks = await getGlobalBrainTicks(env.DB, todayKey());
    if (ticks >= caps.dailyUsdCap * TICKS_PER_USD) {
      return { allowed: false, reason: "daily_usd_cap", ticks };
    }
    return { allowed: true, ticks };
  } catch {
    return { allowed: false, reason: "usage_read_failed" };
  }
}

/** Estimated cost ticks for metered voice seconds ($0.05/min by default). */
export function voiceSecondsToTicks(seconds, pricePerMinUsd = 0.05) {
  const s = Number(seconds) || 0;
  if (s <= 0) return 0;
  return Math.round((s / 60) * pricePerMinUsd * TICKS_PER_USD);
}
