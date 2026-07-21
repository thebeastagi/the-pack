// the-pack — den-fire credits (phase 1 monetisation, pack-monetisation-plan §2).
// 1 credit = $0.01 list. Prepaid, non-transferable, no cash-out.
//
// MONEY-SAFETY DESIGN (fail-closed, mirroring src/caps.js):
//   * atomicDebit is the ONLY way to spend. The guarded UPDATE
//     (WHERE balance >= ?) makes negative balances and double-spends
//     impossible at the SQL level — a raced concurrent debit changes 0 rows
//     and is reported as insufficient.
//   * Debit + ledger append run in ONE D1 batch (transactional): no debit
//     without an audit row, and balance_after is read post-mutation inside
//     the same batch.
//   * The debit itself is NOT raise-safe on the burn path (no debit → no
//     paid call). Read helpers are raise-safe for page rendering only.
import { SQL } from "./db.js";
import { nowIso, uuid } from "./util.js";

export const CREDIT_SKUS = Object.freeze({
  spark: { sku: "spark", amountCents: 500, credits: 500, label: "Spark", bonus: null },
  ember: { sku: "ember", amountCents: 1000, credits: 1100, label: "Ember", bonus: "+10%" },
  fire: { sku: "fire", amountCents: 2000, credits: 2500, label: "Fire", bonus: "+25%" },
  inferno: { sku: "inferno", amountCents: 5000, credits: 7000, label: "Inferno", bonus: "+40%" },
});

// Flat burn floors (credits per paid call) — plan §2.3. The actual charge is
// max(floor, ceil(real_ticks × PRICE_MULTIPLIER / 1e10 × 100)): USD-tick
// denominated so pricing self-heals against xAI repricing (the $0.002→$0.020
// image lesson). Pre-call we only know the floor; post-call settleBurn
// collects any multiplier-driven difference.
export const BURN_FLOORS = Object.freeze({ search: 5, image: 4 });

const TICKS_PER_USD = 10_000_000_000;

export function priceMultiplier(env) {
  const m = Number(env.PRICE_MULTIPLIER);
  return Number.isFinite(m) && m > 0 ? m : 2.0;
}

/** Credits to charge for a call whose exact billed cost is `ticks`. */
export function burnQuote(env, kind, ticks) {
  const floor = BURN_FLOORS[kind] || 0;
  const dynamic = Math.ceil(((Number(ticks) || 0) * priceMultiplier(env) * 100) / TICKS_PER_USD);
  return Math.max(floor, dynamic);
}

/**
 * Spend `amount` credits from a user's balance. Returns
 * { ok:true, balanceAfter } | { ok:false, reason:"insufficient", balance }.
 * Throws on D1 failure — callers on the burn path treat a throw as
 * fail-closed (no paid call happens).
 */
export async function atomicDebit(db, userId, amount, kind, ref = null) {
  const n = Math.max(1, Math.round(Number(amount) || 0));
  // Fast path: visibly insufficient → no writes at all.
  const pre = await db.prepare(SQL.creditBalanceGet).bind(userId).first();
  const preBalance = Number(pre?.balance) || 0;
  if (preBalance < n) return { ok: false, reason: "insufficient", balance: preBalance };

  const ledgerId = uuid();
  const [debitRes] = await db.batch([
    db.prepare(SQL.creditDebit).bind(n, userId, n),
    db.prepare(SQL.creditLedgerInsert).bind(ledgerId, userId, -n, kind, ref, nowIso(), userId),
  ]);
  if (!debitRes?.meta?.changes) {
    // Lost a race to a concurrent debit between the pre-read and the batch:
    // the guarded UPDATE changed nothing, so remove the phantom ledger row.
    try {
      await db.prepare(SQL.creditLedgerDelete).bind(ledgerId).run();
    } catch {}
    const now = await db.prepare(SQL.creditBalanceGet).bind(userId).first();
    return { ok: false, reason: "insufficient", balance: Number(now?.balance) || 0 };
  }
  const after = await db.prepare(SQL.creditBalanceGet).bind(userId).first();
  return { ok: true, balanceAfter: Number(after?.balance) || 0 };
}

/**
 * Grant `amount` credits (purchase settle, admin, promo). Upsert + ledger in
 * one batch. Returns { ok:true, balanceAfter }. Throws on D1 failure.
 */
export async function grantCredits(db, userId, amount, kind, ref = null) {
  const n = Math.max(1, Math.round(Number(amount) || 0));
  await db.batch([
    db.prepare(SQL.creditGrant).bind(userId, n),
    db.prepare(SQL.creditLedgerInsert).bind(uuid(), userId, n, kind, ref, nowIso(), userId),
  ]);
  const after = await db.prepare(SQL.creditBalanceGet).bind(userId).first();
  return { ok: true, balanceAfter: Number(after?.balance) || 0 };
}

/**
 * Post-call settle for a paid burn: the pre-call debit charged the flat
 * floor; once xAI returns exact ticks we top up to the multiplier quote if
 * the real cost ran hotter. RAISE-SAFE by design (like logBrainUsage): a
 * settle failure must never break a reply that already happened — the next
 * pre-flight debit failing closed bounds the damage to one call.
 */
export async function settleBurn(db, env, userId, kind, ref, actualTicks, preCharged) {
  try {
    const due = burnQuote(env, kind, actualTicks);
    const extra = due - (Number(preCharged) || 0);
    if (extra <= 0) return { settled: false, due };
    const debit = await atomicDebit(db, userId, extra, `burn:${kind}:settle`, ref);
    return { settled: debit.ok, due, extra: debit.ok ? extra : 0, reason: debit.reason || null };
  } catch {
    return { settled: false, due: null };
  }
}
