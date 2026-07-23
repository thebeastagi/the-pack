// the-pack — phase 1 monetisation: AllScale payments. Hermetic: AllScale API
// is a stubbed fetch; webhooks are signed in-test with a throwaway secret
// using the documented 'allscale:webhook:v1' canonical.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeDoNamespace, createFakeR2, installWebSocketStubs } from "./fakes.js";
import { accessGateApplies } from "../src/auth.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);
const jsonHeaders = { "content-type": "application/json" };
const WH_SECRET = "test-allscale-secret";
const WH_PATH = "/api/payments/allscale/webhook";

function makeEnv(overrides = {}) {
  const DB = createFakeD1();
  return {
    DB,
    DEN_ROOMS: createFakeDoNamespace({ DB }),
    MEDIA: createFakeR2(),
    ADMIN_TOKEN: "test-admin-token",
    PACK_VERSION: "test",
    PRIVATE_BETA: "0",
    HOSTNAME: "pack.test",
    ALLSCALE_API_KEY: "ask_test",
    ALLSCALE_API_SECRET: WH_SECRET,
    ...overrides,
  };
}

// Fleet lesson: module-global softRateLimit buckets are shared across tests —
// give every test human a distinct client IP.
let ipN = 0;
const nextIp = () => `10.99.${(ipN >> 8) & 255}.${ipN++ & 255}`;

async function claimHuman(env, handle) {
  const res = await worker.fetch(
    req("/api/handles", { method: "POST", headers: { ...jsonHeaders, "cf-connecting-ip": nextIp() }, body: JSON.stringify({ handle }) }),
    env,
  );
  return { cookie: res.headers.get("set-cookie").split(";")[0], res };
}
const userIdByHandle = (env, handle) => env.DB._tables.users.find((u) => u.handle === handle).id;

function stubFetch(responder) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = await responder(String(url), init);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  calls.restore = () => { globalThis.fetch = orig; };
  return calls;
}

async function sha256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Sign a webhook exactly per AllScale's documented canonical (docs.allscale.io
// → Webhook Signing & Payload Guide).
async function signWebhook({ body, webhookId, timestamp, nonce, path = WH_PATH, secret = WH_SECRET }) {
  const bodyHash = await sha256Hex(body);
  const canonical = ["allscale:webhook:v1", "POST", path, "", webhookId, timestamp, nonce, bodyHash].join("\n");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return `v1=${btoa(bin)}`;
}

async function postWebhook(env, payload, { sign = true, stale = false, secret = WH_SECRET, webhookId = "whk_test_1", nonce = "nonce-1" } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000) - (stale ? 999 : 0));
  const headers = { "content-type": "application/json", "X-Webhook-Id": webhookId, "X-Webhook-Timestamp": timestamp, "X-Webhook-Nonce": nonce };
  headers["X-Webhook-Signature"] = sign
    ? await signWebhook({ body, webhookId, timestamp, nonce, secret })
    : "v1=forged";
  return worker.fetch(new Request(`https://pack.test${WH_PATH}`, { method: "POST", headers, body }), env);
}

// Create an order through the real create-intent route (AllScale stubbed).
async function createOrder(env, cookie, pack = "spark") {
  const calls = stubFetch((url, init) => {
    assert.equal(url, "https://openapi.allscale.io/v1/checkout_intents/");
    assert.equal(init.headers["X-API-Key"], "ask_test");
    assert.match(init.headers["X-Signature"], /^v1=/);
    return {
      status: 200,
      body: { code: 0, payload: { checkout_url: "https://app.allscale.io/pay/checkout/abc123", allscale_checkout_intent_id: "chk_test_1", amount_coins: "5.000000" } },
    };
  });
  const res = await worker.fetch(
    req("/api/payments/allscale/create-intent", { method: "POST", headers: { ...jsonHeaders, cookie, "cf-connecting-ip": nextIp() }, body: JSON.stringify({ pack }) }),
    env,
  );
  calls.restore();
  return res;
}

const webhookPayload = (order, { cents = order.amount_cents, orderRef = order.order_ref, webhookId = "whk_test_1" } = {}) => ({
  all_scale_transaction_id: "txn_1",
  all_scale_checkout_intent_id: order.provider_ref,
  webhook_id: webhookId,
  amount_cents: cents,
  currency: null,
  currency_symbol: null,
  amount_coins: "5.000000",
  coin_symbol: "USDC",
  chain_id: 1,
  tx_hash: "0xdeadbeef",
  tx_from: "0xbuyer",
  payment_method_type: 1,
  order_id: orderRef,
  extra_obj: { source: "the-pack", sku: order.sku },
});

// ── create-intent ────────────────────────────────────────────────────────────

test("create-intent: auth required; unconfigured → honest 503; bad pack → 400", async () => {
  const env = makeEnv();
  const anon = await worker.fetch(req("/api/payments/allscale/create-intent", { method: "POST", headers: jsonHeaders, body: "{}" }), env);
  assert.equal(anon.status, 401);

  const envNoKeys = makeEnv({ ALLSCALE_API_KEY: undefined, ALLSCALE_API_SECRET: undefined });
  const { cookie: c0 } = await claimHuman(envNoKeys, "early-bird");
  const off = await worker.fetch(
    req("/api/payments/allscale/create-intent", { method: "POST", headers: { ...jsonHeaders, cookie: c0 }, body: JSON.stringify({ pack: "spark" }) }),
    envNoKeys,
  );
  assert.equal(off.status, 503);
  assert.equal((await off.json()).error.code, "payments_not_configured");

  const { cookie } = await claimHuman(env, "pack-picker");
  const bad = await worker.fetch(
    req("/api/payments/allscale/create-intent", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ pack: "whale" }) }),
    env,
  );
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "bad_pack");
});

test("create-intent: SKU-pinned amount, pack: order_ref namespacing, order persisted", async () => {
  const env = makeEnv();
  const { cookie } = await claimHuman(env, "buyer-wolf");
  const uid = userIdByHandle(env, "buyer-wolf");

  const res = await createOrder(env, cookie, "fire");
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.checkout_url, "https://app.allscale.io/pay/checkout/abc123");
  assert.equal(body.credits, 2500);
  assert.equal(body.amount_cents, 2000); // SKU-pinned — client cannot choose

  const order = env.DB._tables.payment_orders[0];
  assert.equal(order.user_id, uid);
  assert.equal(order.sku, "fire");
  assert.equal(order.status, "created");
  assert.equal(order.provider_ref, "chk_test_1");
  // payment-ux: order_ref is pack:{uuid} — the hosted AllScale page renders it
  // to the payer (Details → Order ID), so it must NOT leak the internal user id.
  assert.match(order.order_ref, /^pack:[0-9a-f-]{36}$/);
  assert.ok(!order.order_ref.includes(uid), "order_ref must not embed the user UUID");
});

// ── webhook ──────────────────────────────────────────────────────────────────

test("webhook: unsigned 401, forged 401, stale 401 — and never grants", async () => {
  const env = makeEnv();
  const { cookie } = await claimHuman(env, "wh-wolf");
  await createOrder(env, cookie);
  const order = env.DB._tables.payment_orders[0];

  const noSig = await worker.fetch(
    new Request(`https://pack.test${WH_PATH}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(webhookPayload(order)) }),
    env,
  );
  assert.equal(noSig.status, 401);
  assert.equal((await noSig.json()).error.code, "missing_signature_headers");

  const forged = await postWebhook(env, webhookPayload(order), { sign: false });
  assert.equal(forged.status, 401);
  assert.equal((await forged.json()).error.code, "invalid_signature");

  const stale = await postWebhook(env, webhookPayload(order), { stale: true });
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).error.code, "stale_webhook");

  assert.equal(env.DB._tables.credit_ledger.length, 0, "no grant from rejected webhooks");
  assert.equal(order.status, "created");
});

test("webhook: valid signature settles — credits granted, ledger row, replay → 409", async () => {
  const env = makeEnv();
  const { cookie } = await claimHuman(env, "settle-wolf");
  const uid = userIdByHandle(env, "settle-wolf");
  await createOrder(env, cookie);
  const order = env.DB._tables.payment_orders[0];

  const res = await postWebhook(env, webhookPayload(order));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.settled, true);
  assert.equal(body.credits, 500);
  assert.equal(body.balance, 500);

  assert.equal(order.status, "settled");
  assert.ok(order.settled_at);
  assert.equal(env.DB._tables.credit_balances.find((r) => r.user_id === uid).balance, 500);
  const grant = env.DB._tables.credit_ledger.find((l) => l.kind === "purchase");
  assert.equal(grant.delta, 500);
  assert.equal(grant.ref, order.id);
  assert.equal(grant.balance_after, 500);

  // replay: same webhook again → 409, no double-grant
  const replay = await postWebhook(env, webhookPayload(order));
  assert.equal(replay.status, 409);
  assert.equal(env.DB._tables.credit_balances.find((r) => r.user_id === uid).balance, 500);
  assert.equal(env.DB._tables.credit_ledger.filter((l) => l.kind === "purchase").length, 1);
});

test("webhook: unknown order 404 (safe), amount/order_ref mismatch 422, webhook_id mismatch 401", async () => {
  const env = makeEnv();
  const { cookie } = await claimHuman(env, "guard-wolf");
  await createOrder(env, cookie);
  const order = env.DB._tables.payment_orders[0];

  const unknown = await postWebhook(env, webhookPayload({ ...order, provider_ref: "chk_someone_else" }));
  assert.equal(unknown.status, 404);

  const shortChanged = await postWebhook(env, webhookPayload(order, { cents: 100 }));
  assert.equal(shortChanged.status, 422);
  assert.equal((await shortChanged.json()).error.code, "order_mismatch");

  const wrongRef = await postWebhook(env, webhookPayload(order, { orderRef: "pack:someone:else" }));
  assert.equal(wrongRef.status, 422);

  const idMismatch = await postWebhook(env, webhookPayload(order, { webhookId: "whk_in_body" }), { webhookId: "whk_in_header" });
  assert.equal(idMismatch.status, 401);
  assert.equal((await idMismatch.json()).error.code, "webhook_id_mismatch");

  assert.equal(env.DB._tables.credit_ledger.length, 0);
  assert.equal(order.status, "created");
});

test("webhook: reachable BEFORE the Access gate (pre-gate route + bypass list)", async () => {
  // worker bypass list mirrors the edge bypass app (lockstep lesson)
  assert.equal(accessGateApplies({ PRIVATE_BETA: "1" }, WH_PATH, new Request(`https://pack.test${WH_PATH}`, { method: "POST" })), false);

  // gated env, no Access headers at all: a forged webhook gets the HANDLER's
  // 401 — not the 403 gate page — proving the pre-gate registration works.
  const env = makeEnv({ PRIVATE_BETA: "1" });
  const res = await postWebhook(env, { hello: "world" }, { sign: false });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "invalid_signature");
});

// ── reconcile (shared-store status-poll settle) ─────────────────────────────

test("reconcile: owner-only, pending → created, CONFIRMED(20) → settled once", async () => {
  const env = makeEnv();
  const { cookie } = await claimHuman(env, "poll-wolf");
  const uid = userIdByHandle(env, "poll-wolf");
  const { cookie: stranger } = await claimHuman(env, "stranger-wolf");
  await createOrder(env, cookie);
  const order = env.DB._tables.payment_orders[0];

  const anon = await worker.fetch(req(`/api/payments/orders/${order.id}/reconcile`, { method: "POST" }), env);
  assert.equal(anon.status, 401);
  const notYours = await worker.fetch(req(`/api/payments/orders/${order.id}/reconcile`, { method: "POST", headers: { cookie: stranger } }), env);
  assert.equal(notYours.status, 404);

  // pending upstream
  let calls = stubFetch(() => ({ status: 200, body: { code: 0, payload: { status: 10 } } }));
  const pending = await worker.fetch(req(`/api/payments/orders/${order.id}/reconcile`, { method: "POST", headers: { cookie } }), env);
  calls.restore();
  assert.equal((await pending.json()).status, "confirming");
  assert.equal(order.status, "created");

  // CONFIRMED upstream → settle
  calls = stubFetch((url, init) => {
    assert.match(url, /\/v1\/checkout_intents\/chk_test_1$/);
    assert.equal(init.headers["X-API-Key"], "ask_test");
    return { status: 200, body: { code: 0, payload: { status: 20, amount_cents: order.amount_cents, order_id: order.order_ref } } };
  });
  const settled = await worker.fetch(req(`/api/payments/orders/${order.id}/reconcile`, { method: "POST", headers: { cookie } }), env);
  calls.restore();
  const body = await settled.json();
  assert.equal(body.status, "settled");
  assert.equal(body.credits, 500);
  assert.equal(body.balance, 500);
  assert.equal(env.DB._tables.credit_balances.find((r) => r.user_id === uid).balance, 500);

  // second reconcile is a safe no-op (no upstream call needed, no double grant)
  const again = await worker.fetch(req(`/api/payments/orders/${order.id}/reconcile`, { method: "POST", headers: { cookie } }), env);
  assert.equal((await again.json()).status, "settled");
  assert.equal(env.DB._tables.credit_ledger.filter((l) => l.kind === "purchase").length, 1);
});

// ── pages ────────────────────────────────────────────────────────────────────

test("/pay renders packs + honest terms; unconfigured → offline note + disabled buttons", async () => {
  const env = makeEnv({ ALLSCALE_API_KEY: undefined, ALLSCALE_API_SECRET: undefined });
  const { cookie } = await claimHuman(env, "window-shopper");
  const html = await (await worker.fetch(req("/pay", { headers: { cookie } }), env)).text();
  assert.match(html, /Den-fire credits/);
  assert.match(html, /Spark/);
  assert.match(html, /Inferno/);
  assert.match(html, /7,000 cr/);
  assert.match(html, /non-refundable, non-transferable, no cash-out/);
  assert.match(html, /being wired up/); // honest unconfigured state
  assert.match(html, /<button class="btn fire" disabled>Feed the fire — \$5<\/button>/);
  assert.doesNotMatch(html, /\/pay\/checkout\?pack=/); // no checkout links while offline

  const envLive = makeEnv();
  const { cookie: c2 } = await claimHuman(envLive, "ready-buyer");
  const html2 = await (await worker.fetch(req("/pay", { headers: { cookie: c2 } }), envLive)).text();
  // payment-ux: cards link to the in-Pack pre-checkout confirm screen.
  assert.match(html2, /href="\/pay\/checkout\?pack=spark"/);
  assert.match(html2, /href="\/pay\/checkout\?pack=inferno"/);
  assert.doesNotMatch(html2, /<button class="btn fire" disabled/);

  // /pay/thanks renders the settle watcher (payment-ux states)
  const thanks = await (await worker.fetch(req("/pay/thanks", { headers: { cookie: c2 } }), envLive)).text();
  assert.match(thanks, /Confirming your payment/);
  assert.match(thanks, /reconcile/);
  assert.match(thanks, /pack_pay_ctx/);
});

test("served inline scripts parse on /pay + /pay/thanks + authed home (credits pill)", async () => {
  const env = makeEnv();
  const { cookie } = await claimHuman(env, "script-wolf");
  const scriptsOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  for (const path of ["/pay", "/pay/thanks", "/"]) {
    const html = await (await worker.fetch(req(path, { headers: { cookie } }), env)).text();
    const scripts = scriptsOf(html);
    assert.ok(scripts.length >= 1, `${path} should serve inline scripts`);
    for (const src of scripts) assert.doesNotThrow(() => new Function(src), `${path} inline script must parse`);
  }
  const home = await (await worker.fetch(req("/", { headers: { cookie } }), env)).text();
  assert.match(home, /id="cr-pill"/);
  assert.match(home, /\/api\/credits/);
});
