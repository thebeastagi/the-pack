// the-pack — phase 1 monetisation: credits core + burn wiring. Hermetic:
// D1 is the SQL-dispatching fake (with batch()), xAI is a stubbed fetch.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeDoNamespace, createFakeR2, installWebSocketStubs } from "./fakes.js";
import { SQL } from "../src/db.js";
import { atomicDebit, grantCredits, burnQuote, settleBurn, BURN_FLOORS, CREDIT_SKUS } from "../src/credits.js";
import { brainAllowedOrBurn } from "../src/caps.js";
import { todayKey } from "../src/caps.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);
const jsonHeaders = { "content-type": "application/json" };
const PNG_B64 = Buffer.from(new Uint8Array(2048).fill(7)).toString("base64");

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
    ...overrides,
  };
}

// Fleet lesson: module-global softRateLimit buckets are shared across tests —
// give every test human a distinct client IP.
let ipN = 0;
const nextIp = () => `10.88.${(ipN >> 8) & 255}.${ipN++ & 255}`;

async function claimHuman(env, handle) {
  const res = await worker.fetch(
    req("/api/handles", { method: "POST", headers: { ...jsonHeaders, "cf-connecting-ip": nextIp() }, body: JSON.stringify({ handle }) }),
    env,
  );
  return { cookie: res.headers.get("set-cookie").split(";")[0], res };
}

async function userIdByHandle(env, handle) {
  const row = env.DB._tables.users.find((u) => u.handle === handle);
  return row.id;
}

async function seedLobby(env) {
  const res = await worker.fetch(
    req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "test-admin-token", ...jsonHeaders }, body: "{}" }),
    env,
  );
  return (await res.json()).key;
}

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

// ── SKU table (plan §2.2 — approved pricing, locked by test) ────────────────

test("credit SKUs match the approved plan (Spark/Ember/Fire/Inferno)", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(CREDIT_SKUS).map(([k, v]) => [k, [v.amountCents, v.credits]])),
    { spark: [500, 500], ember: [1000, 1100], fire: [2000, 2500], inferno: [5000, 7000] },
  );
  assert.deepEqual(BURN_FLOORS, { search: 5, image: 4 });
});

// ── atomicDebit / grantCredits ───────────────────────────────────────────────

test("atomicDebit: guarded debit + ledger row in one batch; balance_after is post-debit", async () => {
  const env = makeEnv();
  await claimHuman(env, "cred-wolf");
  const uid = await userIdByHandle(env, "cred-wolf");

  await grantCredits(env.DB, uid, 100, "purchase", "order-1");
  const d = await atomicDebit(env.DB, uid, 30, "burn:search", "lobby");
  assert.equal(d.ok, true);
  assert.equal(d.balanceAfter, 70);

  const ledger = env.DB._tables.credit_ledger;
  assert.equal(ledger.length, 2);
  assert.deepEqual(
    ledger.map((l) => [l.delta, l.kind, l.balance_after]),
    [[100, "purchase", 100], [-30, "burn:search", 70]],
  );
});

test("atomicDebit: insufficient → no writes at all; balance never negative", async () => {
  const env = makeEnv();
  await claimHuman(env, "poor-wolf");
  const uid = await userIdByHandle(env, "poor-wolf");

  const d0 = await atomicDebit(env.DB, uid, 5, "burn:image", "lobby");
  assert.equal(d0.ok, false);
  assert.equal(d0.reason, "insufficient");
  assert.equal(d0.balance, 0);
  assert.equal(env.DB._tables.credit_ledger.length, 0, "no ledger row when nothing was debited");

  await grantCredits(env.DB, uid, 10, "purchase", "o1");
  const d1 = await atomicDebit(env.DB, uid, 11, "burn:image", "lobby");
  assert.equal(d1.ok, false);
  assert.equal(env.DB._tables.credit_balances.find((r) => r.user_id === uid).balance, 10);
  assert.equal(env.DB._tables.credit_ledger.filter((l) => l.delta < 0).length, 0);
});

test("atomicDebit: raced concurrent debits cannot double-spend (guard + phantom cleanup)", async () => {
  const env = makeEnv();
  await claimHuman(env, "race-wolf");
  const uid = await userIdByHandle(env, "race-wolf");
  await grantCredits(env.DB, uid, 100, "purchase", "o1");

  // Both debits pass the fast-path pre-read at balance 100; the guarded
  // UPDATE in the batch must let exactly ONE through.
  const [a, b] = await Promise.all([
    atomicDebit(env.DB, uid, 80, "burn:search", "lobby"),
    atomicDebit(env.DB, uid, 80, "burn:search", "lobby"),
  ]);
  const wins = [a, b].filter((r) => r.ok);
  const losses = [a, b].filter((r) => !r.ok);
  assert.equal(wins.length, 1, "exactly one raced debit succeeds");
  assert.equal(losses.length, 1);
  assert.equal(losses[0].reason, "insufficient");
  const final = env.DB._tables.credit_balances.find((r) => r.user_id === uid).balance;
  assert.equal(final, 20);
  const burns = env.DB._tables.credit_ledger.filter((l) => l.kind === "burn:search");
  assert.equal(burns.length, 1, "phantom ledger row was compensated away");
  assert.equal(burns[0].balance_after, 20);
});

// ── burnQuote / settleBurn (USD-tick self-healing pricing) ──────────────────

test("burnQuote: floor dominates cheap calls; multiplier drives hot calls (self-healing)", () => {
  const env = { PRICE_MULTIPLIER: "2.0" };
  assert.equal(burnQuote(env, "search", 0), 5); // floor
  assert.equal(burnQuote(env, "image", 20_000_000), 4); // $0.002 advertised → floor 4
  assert.equal(burnQuote(env, "image", 200_000_000), 4); // $0.020 REAL billed → 2× → exactly 4
  assert.equal(burnQuote(env, "image", 500_000_000), 10); // $0.050 drift → 2× → 10 (repricing heals)
  assert.equal(burnQuote(env, "search", 348_000_000), 7); // $0.0348 worst search → 6.96 → 7
  assert.equal(burnQuote({}, "search", 348_000_000), 7); // default multiplier 2.0
});

test("settleBurn: collects the multiplier difference post-call; silent when floor covers", async () => {
  const env = makeEnv({ PRICE_MULTIPLIER: "2.0" });
  await claimHuman(env, "settle-wolf");
  const uid = await userIdByHandle(env, "settle-wolf");
  await grantCredits(env.DB, uid, 100, "purchase", "o1");

  // pre-charged 4 (image floor); real cost $0.020 → due 4 → nothing extra
  const s1 = await settleBurn(env.DB, env, uid, "image", "lobby", 200_000_000, 4);
  assert.equal(s1.settled, false);
  // real cost $0.050 → due 10 → 6 more burned
  const s2 = await settleBurn(env.DB, env, uid, "image", "lobby", 500_000_000, 4);
  assert.equal(s2.settled, true);
  assert.equal(s2.extra, 6);
  assert.equal(env.DB._tables.credit_balances.find((r) => r.user_id === uid).balance, 94);
  assert.equal(env.DB._tables.credit_ledger.at(-1).kind, "burn:image:settle");
});

// ── brainAllowedOrBurn (the cap seam) ────────────────────────────────────────

test("burn wiring: free pool first, then paid burn; hard ceilings never burn", async () => {
  const env = makeEnv({ PACK_FREE_SEARCH_DEN_CAP: "1" });
  await claimHuman(env, "burn-wolf");
  const uid = await userIdByHandle(env, "burn-wolf");
  await grantCredits(env.DB, uid, 50, "purchase", "o1");

  // call 1: free
  const c1 = await brainAllowedOrBurn(env, "lobby", "search", uid);
  assert.equal(c1.allowed, true);
  assert.equal(c1.paid, false);
  // consume the free slot
  env.DB._tables.brain_usage.push({ day: todayKey(), den: "lobby", kind: "search", calls: 1, ticks: 50_000_000 });

  // call 2: free pool exhausted → burn 5 credits → allowed paid
  const c2 = await brainAllowedOrBurn(env, "lobby", "search", uid);
  assert.equal(c2.allowed, true);
  assert.equal(c2.paid, true);
  assert.equal(c2.burned, 5);
  assert.equal(c2.balance, 45);
  assert.equal(c2.via, "den_cap");
});

test("burn wiring: insufficient credits → denied with honest insufficiency (no negative)", async () => {
  const env = makeEnv({ PACK_FREE_SEARCH_DEN_CAP: "0", PACK_SEARCH_DEN_CAP: "40" });
  await claimHuman(env, "broke-wolf");
  const uid = await userIdByHandle(env, "broke-wolf");
  // free cap 0 → straight to burn attempt with a 0 balance
  const c = await brainAllowedOrBurn(env, "lobby", "search", uid);
  assert.equal(c.allowed, false);
  assert.equal(c.reason, "den_cap");
  assert.equal(c.insufficient, true);
  assert.equal(c.balance, 0);
  assert.equal(c.burn, 5);
});

test("burn wiring: daily_usd_cap + usage_read_failed + hard den cap are HARD refusals (credits do NOT override)", async () => {
  const env = makeEnv({ PACK_BRAIN_DAILY_USD_CAP: "0.01", PACK_FREE_DAILY_USD_CAP: "2.00" });
  await claimHuman(env, "rich-wolf");
  const uid = await userIdByHandle(env, "rich-wolf");
  await grantCredits(env.DB, uid, 10_000, "purchase", "o1");

  // hard daily USD ceiling tripped → refusal, zero credits burned
  env.DB._tables.brain_usage.push({ day: todayKey(), den: "*", kind: "search", calls: 1, ticks: 500_000_000 }); // $0.05 > $0.01
  const c1 = await brainAllowedOrBurn(env, "lobby", "search", uid);
  assert.equal(c1.allowed, false);
  assert.equal(c1.reason, "daily_usd_cap");
  assert.equal(env.DB._tables.credit_balances.find((r) => r.user_id === uid).balance, 10_000);

  // ledger read failure → fail CLOSED even with credits
  const env2 = makeEnv();
  env2.DB._tables.credit_balances.push({ user_id: uid, balance: 10_000 });
  const realPrepare = env2.DB.prepare;
  env2.DB.prepare = (sql) => {
    if (sql === SQL.brainUsageGet) throw new Error("d1 down");
    return realPrepare(sql);
  };
  const c2 = await brainAllowedOrBurn(env2, "lobby", "search", uid);
  assert.equal(c2.allowed, false);
  assert.equal(c2.reason, "usage_read_failed");

  // hard per-den ceiling (PACK_SEARCH_DEN_CAP) tripped → refusal even with credits
  const env3 = makeEnv({ PACK_SEARCH_DEN_CAP: "2", PACK_FREE_SEARCH_DEN_CAP: "1" });
  env3.DB._tables.credit_balances.push({ user_id: uid, balance: 10_000 });
  env3.DB._tables.brain_usage.push({ day: todayKey(), den: "lobby", kind: "search", calls: 2, ticks: 1 });
  const c3 = await brainAllowedOrBurn(env3, "lobby", "search", uid);
  assert.equal(c3.allowed, false);
  assert.equal(c3.reason, "den_hard_cap");
  assert.equal(env3.DB._tables.credit_balances[0].balance, 10_000);
});

// ── /api/credits ─────────────────────────────────────────────────────────────

test("GET /api/credits: 401 unauth; authed → balance + ledger + orders", async () => {
  const env = makeEnv();
  const anon = await worker.fetch(req("/api/credits"), env);
  assert.equal(anon.status, 401);

  const { cookie } = await claimHuman(env, "ledger-wolf");
  const uid = await userIdByHandle(env, "ledger-wolf");
  await grantCredits(env.DB, uid, 500, "purchase", "order-xyz");
  await atomicDebit(env.DB, uid, 4, "burn:image", "lobby");

  const res = await worker.fetch(req("/api/credits", { headers: { cookie } }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.balance, 496);
  assert.equal(body.ledger.length, 2);
  assert.equal(body.ledger[0].kind, "burn:image"); // most recent first
  assert.equal(body.ledger[0].balance_after, 496);
});

// ── /imagine paid path (end-to-end burn through the API) ────────────────────

test("/imagine past the free pool: credits burn, paid flag in response, ledger shows burn", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test", PACK_FREE_IMAGE_DEN_CAP: "0" });
  const { cookie } = await claimHuman(env, "paid-artist");
  const uid = await userIdByHandle(env, "paid-artist");
  await seedLobby(env);
  await grantCredits(env.DB, uid, 100, "purchase", "o1");

  const calls = stubFetch(() => ({
    status: 200,
    body: { data: [{ b64_json: PNG_B64, mime_type: "image/png" }], usage: { cost_in_usd_ticks: 200_000_000 } },
  }));
  const res = await worker.fetch(
    req("/api/dens/lobby/messages", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ body: "/imagine a paid wolf" }) }),
    env,
  );
  calls.restore();
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.imagined, true);
  assert.deepEqual(body.paid, { kind: "image", burned: 4, balance: 96 });
  // usage still ledgered (hard ceilings keep working for paid calls)
  assert.equal(env.DB._tables.brain_usage.find((r) => r.kind === "image").calls, 1);
  const burnRow = env.DB._tables.credit_ledger.find((l) => l.kind === "burn:image");
  assert.equal(burnRow.delta, -4);
  assert.equal(burnRow.balance_after, 96);
});

test("/imagine past the free pool with no credits: honest 429 pointing at /pay", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test", PACK_FREE_IMAGE_DEN_CAP: "0" });
  const { cookie } = await claimHuman(env, "free-artist");
  await seedLobby(env);
  const calls = stubFetch(() => ({ status: 500, body: {} }));
  const res = await worker.fetch(
    req("/api/dens/lobby/messages", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ body: "/imagine a wolf" }) }),
    env,
  );
  calls.restore();
  assert.equal(res.status, 429);
  const err = (await res.json()).error;
  assert.equal(err.code, "imagine_capped");
  assert.match(err.message, /\/pay/);
  assert.match(err.message, /Nothing was charged/);
  assert.equal(calls.length, 0, "no paid upstream call without a successful debit");
});

test("generate seam past the free pool: agent's own credits pay for live search", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test", XAI_CHAT_MODEL: "grok-test", PACK_FREE_SEARCH_DEN_CAP: "0" });
  const key = await seedLobby(env);
  const keeperUid = env.DB._tables.users.find((u) => u.handle === "den-keeper").id;
  await grantCredits(env.DB, keeperUid, 20, "purchase", "o1");

  const calls = stubFetch((url) => {
    if (url === "https://api.x.ai/v1/responses") {
      return {
        status: 200,
        body: {
          output: [{ type: "message", content: [{ type: "output_text", text: "paid live answer" }] }],
          usage: { server_side_tool_usage_details: { web_search_calls: 1, x_search_calls: 0 }, cost_in_usd_ticks: 50_000_000 },
        },
      };
    }
    return { status: 404, body: {} };
  });
  const res = await worker.fetch(
    req("/api/dens/lobby/messages", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
      body: JSON.stringify({ body: "latest news?", generate: true }),
    }),
    env,
  );
  calls.restore();
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.brain.search, "used");
  assert.deepEqual(body.paid, { kind: "search", burned: 5, balance: 15 });
  assert.equal(env.DB._tables.credit_ledger.find((l) => l.kind === "burn:search").balance_after, 15);
});
