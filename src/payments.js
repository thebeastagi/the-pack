// the-pack — AllScale hosted-checkout payments (phase 1 monetisation).
// Ported from the battle-tested dashboard worker handlers
// (allscale-go-public-2026-07-16 / allscale-production-integration-2026-07-15),
// adapted to pack conventions: zero-dep ESM, D1 (not KV) idempotency via
// payment_orders UNIQUE(provider, provider_ref) + guarded settle, pack's
// json/apiError helpers.
//
// SETTLE PATHS (two, one shared core — see settleOrder):
//   1. Webhook: AllScale POSTs HMAC-signed payment notifications. On the
//      SHARED Beast store the store-level webhook URL currently points at the
//      dashboard worker, so pack orders may never see a webhook — which is
//      why path 2 exists. Route is registered in worker.js BEFORE the Access
//      gate and mirrored in ACCESS_BYPASS_PATHS + a CF Access bypass app.
//   2. Reconcile: the pack holds the same store's API credentials, so a
//      signed GET /v1/checkout_intents/{id} is authoritative. /pay/thanks
//      polls the reconcile endpoint; status 20 (CONFIRMED) settles.
// Both paths verify the amount + order_ref before granting a single credit.
import * as db from "./db.js";
import { recordPackEpisode } from "./episodes.js";
import { apiError, clientIp, clampStr, json, sha256Hex, softRateLimit, uuid } from "./util.js";

const ALLSCALE_STABLECOIN_ENUM = Object.freeze({ USDT: 1, USDC: 2 });
export const INTENT_STATUS = Object.freeze({ PENDING: 1, SEND_BACK: 5, ON_CHAIN: 10, CONFIRMED: 20 });

export function allScaleConfigured(env) {
  return Boolean(env.ALLSCALE_API_KEY && env.ALLSCALE_API_SECRET);
}

function baseUrl(env) {
  return env.ALLSCALE_BASE_URL || "https://openapi.allscale.io";
}

function base64FromBytes(buffer) {
  let binary = "";
  for (const b of new Uint8Array(buffer)) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function hmacBase64(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64FromBytes(sig);
}

// Constant-time string compare (signatures are base64, not hex).
function safeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signAllScaleRequest(env, method, path, query, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body || "");
  const canonical = [method.toUpperCase(), path, query || "", timestamp, nonce, bodyHash].join("\n");
  const signature = await hmacBase64(env.ALLSCALE_API_SECRET, canonical);
  return { "X-API-Key": env.ALLSCALE_API_KEY, "X-Timestamp": timestamp, "X-Nonce": nonce, "X-Signature": `v1=${signature}` };
}

async function allScaleFetch(env, method, path, body) {
  const bodyStr = body || "";
  const headers = await signAllScaleRequest(env, method, path, "", bodyStr);
  const res = await fetch(`${baseUrl(env)}${path}`, {
    method,
    headers: { ...headers, ...(bodyStr ? { "Content-Type": "application/json" } : {}) },
    body: bodyStr || undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* upstream non-JSON */ }
  return { status: res.status, ok: res.ok, parsed };
}

// ── create-intent (session-authed; credits must attach to a known user) ────
// Body: { pack: "spark"|"ember"|"fire"|"inferno" }. Amounts are SKU-enum
// restricted (never free-form). order_id is server-generated with the
// approved pack:{userId}:{uuid} namespacing on the shared Beast store.
export async function handleCreateIntent(request, env, identity, skus) {
  if (!allScaleConfigured(env)) {
    return apiError(503, "payments_not_configured", "Credit checkout is being wired up — packs are not on sale yet. Nothing was charged.");
  }
  if (
    !softRateLimit(`payip:${clientIp(request)}`, 6, 60_000) ||
    !softRateLimit(`payuser:${identity.user.id}`, 10, 24 * 3600_000) ||
    !softRateLimit("payglobal", 120, 60_000)
  ) {
    return apiError(429, "rate_limited", "Too many checkout attempts. Try later.");
  }
  let body;
  try { body = await request.json(); } catch { return apiError(400, "bad_json", "Expected a JSON body."); }
  const sku = skus[clampStr(body?.pack, 20).toLowerCase()];
  if (!sku) return apiError(400, "bad_pack", "Unknown credit pack. Choose Spark, Ember, Fire, or Inferno.");

  const orderId = uuid();
  const orderRef = `pack:${identity.user.id}:${orderId}`;
  await db.createPaymentOrder(env.DB, {
    id: orderId,
    userId: identity.user.id,
    provider: "allscale",
    orderRef,
    sku: sku.sku,
    amountCents: sku.amountCents,
    credits: sku.credits,
  });

  const upstreamBody = JSON.stringify({
    amount_cents: sku.amountCents,
    order_id: orderRef,
    order_description: `The Pack — ${sku.credits} den-fire credits (${sku.label} pack)`.slice(0, 240),
    redirect_url: "https://pack.thebeastagi.com/pay/thanks",
    // Priced natively in USDC (1:1 USD, card on-ramp settles USDC); payer may
    // choose USDT on the hosted page instead.
    stable_coin: ALLSCALE_STABLECOIN_ENUM.USDC,
    accepted_stable_coins: [ALLSCALE_STABLECOIN_ENUM.USDC, ALLSCALE_STABLECOIN_ENUM.USDT],
    extra: { source: "the-pack", sku: sku.sku, created_by: "the-pack" },
  });
  let up;
  try {
    up = await allScaleFetch(env, "POST", "/v1/checkout_intents/", upstreamBody);
  } catch {
    return apiError(502, "upstream_unreachable", "Could not reach the payment provider. No order was charged — try again.");
  }
  const payload = up.parsed && typeof up.parsed.payload === "object" && up.parsed.payload ? up.parsed.payload : {};
  const checkoutUrl = typeof payload.checkout_url === "string" ? payload.checkout_url : null;
  if (!up.ok || !up.parsed || up.parsed.code !== 0 || !checkoutUrl) {
    return apiError(502, "create_failed", "The payment provider refused the checkout. Nothing was charged — try again.");
  }
  const intentId = payload.allscale_checkout_intent_id || null;
  if (intentId) await db.setPaymentOrderRef(env.DB, orderId, String(intentId));
  return json({
    ok: true,
    order_id: orderId,
    pack: sku.sku,
    credits: sku.credits,
    amount_cents: sku.amountCents,
    checkout_url: checkoutUrl,
    checkout_intent_id: intentId,
  }, { status: 201 });
}

// ── settle core (shared by webhook + reconcile) ─────────────────────────────
// Exactly-once at the SQL level: the credit grant + ledger row are guarded by
// EXISTS(order still 'created') INSIDE the same batch transaction, and the
// settle UPDATE flips status last. A replayed or raced settle therefore
// changes 0 rows anywhere — no phantom grants to compensate.
// Returns { state: "settled"|"duplicate", order, balanceAfter? }.
export async function settleOrder(env, ctx, order, via) {
  if (order.status !== "created") return { state: "duplicate", order };
  const settledAt = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(db.SQL.creditGrantIfOrderCreated).bind(order.user_id, order.credits, order.id),
    env.DB.prepare(db.SQL.creditLedgerInsertIfOrderCreated).bind(uuid(), order.user_id, order.credits, "purchase", order.id, settledAt, order.user_id, order.id),
    env.DB.prepare(db.SQL.paymentOrderSettle).bind(settledAt, order.id),
  ]);
  if (!results[2]?.meta?.changes) return { state: "duplicate", order };
  const balance = await db.getCreditBalance(env.DB, order.user_id);
  recordPackEpisode(
    env, ctx, "payment_settled", "pack",
    `payment settled via ${via}: order ${order.id} (${order.sku}, ${order.credits} credits, $${(order.amount_cents / 100).toFixed(2)}) for user ${order.user_id}`,
  );
  return { state: "settled", order, balanceAfter: balance };
}

// Amount + order_ref cross-check: a webhook/reconcile that doesn't echo
// EXACTLY what we sold never grants credits (422, no side effects).
function payloadMatchesOrder(payload, order) {
  const cents = Number(payload?.amount_cents);
  const orderRef = payload?.order_id;
  return Number.isInteger(cents) && cents === order.amount_cents && typeof orderRef === "string" && orderRef === order.order_ref;
}

// ── webhook receiver (HMAC-authenticated, NOT session/auth-gated) ──────────
export async function handleAllScaleWebhook(request, env, url, ctx) {
  if (!env.ALLSCALE_API_SECRET) return apiError(503, "payments_not_configured", "Webhook secret not set on this worker.");
  const webhookId = request.headers.get("X-Webhook-Id") || "";
  const timestamp = request.headers.get("X-Webhook-Timestamp") || "";
  const nonce = request.headers.get("X-Webhook-Nonce") || "";
  const sigHeader = request.headers.get("X-Webhook-Signature") || "";
  const sig = sigHeader.startsWith("v1=") ? sigHeader.slice(3) : sigHeader;
  if (!webhookId || !timestamp || !nonce || !sig) return apiError(401, "missing_signature_headers", "Unsigned webhooks are not accepted.");
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return apiError(401, "stale_webhook", "Webhook timestamp outside the 5-minute window.");

  const raw = new Uint8Array(await request.arrayBuffer());
  const bodyHash = await sha256Hex(raw);
  const canonical = ["allscale:webhook:v1", "POST", url.pathname, url.search ? url.search.slice(1) : "", webhookId, timestamp, nonce, bodyHash].join("\n");
  const expected = await hmacBase64(env.ALLSCALE_API_SECRET, canonical);
  if (!safeEqualStr(sig, expected)) return apiError(401, "invalid_signature", "Webhook signature verification failed.");

  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return apiError(400, "bad_json", "Webhook body is not JSON."); }
  if (payload.webhook_id !== webhookId) return apiError(401, "webhook_id_mismatch", "Payload webhook_id does not match the signed header.");

  const intentId = String(payload.all_scale_checkout_intent_id || payload.checkout_intent_id || "");
  if (!intentId) return apiError(400, "missing_intent_id", "Webhook payload carries no checkout intent id.");
  const order = await db.getPaymentOrderByRef(env.DB, "allscale", intentId);
  if (!order) return apiError(404, "unknown_order", "No pack order for this intent (safe no-op).");
  if (!payloadMatchesOrder(payload, order)) return apiError(422, "order_mismatch", "Webhook amount/order_ref does not match our records. No credits granted.");

  const out = await settleOrder(env, ctx, order, "webhook");
  if (out.state === "duplicate") return apiError(409, "duplicate_webhook", "Order already settled — replay rejected.");
  return json({ ok: true, settled: true, order_id: order.id, credits: order.credits, balance: out.balanceAfter });
}

// ── reconcile (status-poll settle; the shared-store primary path) ──────────
// Session-authed, owner-or-admin only. Signed upstream read → status 20
// (CONFIRMED) → same idempotent settle core as the webhook. Safe to poll.
export async function handleReconcile(request, env, identity, orderId) {
  if (!allScaleConfigured(env)) {
    return apiError(503, "payments_not_configured", "Credit checkout is being wired up — settlement polling is offline.");
  }
  if (!softRateLimit(`reconcile:${identity.user.id}`, 30, 3600_000)) {
    return apiError(429, "rate_limited", "Too many settlement checks. Try later.");
  }
  const order = await db.getPaymentOrderById(env.DB, orderId);
  if (!order || order.user_id !== identity.user.id) return apiError(404, "not_found", "Not found.");
  if (order.status === "settled") {
    const balance = await db.getCreditBalance(env.DB, identity.user.id);
    return json({ ok: true, status: "settled", credits: order.credits, balance });
  }
  if (!order.provider_ref) return json({ ok: true, status: "created" });

  let up;
  try {
    up = await allScaleFetch(env, "GET", `/v1/checkout_intents/${encodeURIComponent(order.provider_ref)}`, "");
  } catch {
    return apiError(502, "upstream_unreachable", "Could not reach the payment provider. The order is unchanged — try again.");
  }
  const payload = up.parsed && typeof up.parsed.payload === "object" && up.parsed.payload ? up.parsed.payload : {};
  if (!up.ok || !up.parsed || up.parsed.code !== 0) {
    return apiError(502, "status_failed", "The payment provider would not report the order status. The order is unchanged.");
  }
  const intentStatus = Number(payload.status);
  if (intentStatus !== INTENT_STATUS.CONFIRMED) {
    return json({ ok: true, status: intentStatus === INTENT_STATUS.ON_CHAIN ? "confirming" : "created", upstream_status: intentStatus });
  }
  // Upstream says PAID. Cross-check the amount before granting (payload from
  // the detail endpoint echoes amount_cents + order_id on confirmed intents).
  if (payload.amount_cents !== undefined && !payloadMatchesOrder(payload, order)) {
    return apiError(422, "order_mismatch", "Upstream amount/order_ref does not match our records. No credits granted.");
  }
  const out = await settleOrder(env, null, order, "reconcile");
  if (out.state === "duplicate") {
    const balance = await db.getCreditBalance(env.DB, identity.user.id);
    return json({ ok: true, status: "settled", credits: order.credits, balance });
  }
  return json({ ok: true, status: "settled", credits: order.credits, balance: out.balanceAfter });
}
