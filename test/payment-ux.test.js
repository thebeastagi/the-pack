// the-pack — payment-ux: in-Pack pre-checkout confirm (/pay/checkout), the
// /pay/thanks return landing, return-context sanitizing, and the payer-visible
// order_ref / redirect_url contract. Hermetic: AllScale fetch stubbed.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeDoNamespace, createFakeR2, installWebSocketStubs } from "./fakes.js";
import { sanitizeFromPath } from "../src/pages.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);
const jsonHeaders = { "content-type": "application/json" };

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
    ALLSCALE_API_SECRET: "test-allscale-secret",
    ...overrides,
  };
}

let ipN = 0;
const nextIp = () => `10.98.${(ipN >> 8) & 255}.${ipN++ & 255}`;

async function claimHuman(env, handle) {
  const res = await worker.fetch(
    req("/api/handles", { method: "POST", headers: { ...jsonHeaders, "cf-connecting-ip": nextIp() }, body: JSON.stringify({ handle }) }),
    env,
  );
  return { cookie: res.headers.get("set-cookie").split(";")[0] };
}

const scriptsOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test("sanitizeFromPath: internal paths pass, open-redirect shapes rejected", () => {
  assert.equal(sanitizeFromPath("/den/lobby"), "/den/lobby");
  assert.equal(sanitizeFromPath("/"), null); // must start with a path char after /
  assert.equal(sanitizeFromPath("//evil.com"), null);
  assert.equal(sanitizeFromPath("https://evil.com"), null);
  assert.equal(sanitizeFromPath("/\\evil"), null);
  assert.equal(sanitizeFromPath('/den/"><script>'), null);
  assert.equal(sanitizeFromPath(null), null);
  assert.equal(sanitizeFromPath(undefined), null);
  assert.equal(sanitizeFromPath(""), null);
  assert.equal(sanitizeFromPath(`/den/${"a".repeat(200)}`), null);
});

test("/pay/checkout: anon → 302, bad sku → 302, unconfigured → 302 (fail closed to /pay)", async () => {
  const env = makeEnv();
  const anon = await worker.fetch(req("/pay/checkout?pack=spark"), env);
  assert.equal(anon.status, 302);
  assert.ok(anon.headers.get("location").endsWith("/pay"));

  const { cookie } = await claimHuman(env, "co-wolf");
  const badSku = await worker.fetch(req("/pay/checkout?pack=whale", { headers: { cookie } }), env);
  assert.equal(badSku.status, 302);

  const envOff = makeEnv({ ALLSCALE_API_KEY: undefined, ALLSCALE_API_SECRET: undefined });
  const { cookie: c2 } = await claimHuman(envOff, "co-wolf-2");
  const off = await worker.fetch(req("/pay/checkout?pack=spark", { headers: { cookie: c2 } }), envOff);
  assert.equal(off.status, 302);
});

test("/pay/checkout: renders review screen — pack, price, handoff steps, USDC explainer, scripts parse", async () => {
  const env = makeEnv();
  const { cookie } = await claimHuman(env, "review-wolf");
  const html = await (await worker.fetch(req("/pay/checkout?pack=ember", { headers: { cookie } }), env)).text();
  assert.match(html, /Ember pack/);
  assert.match(html, /\$10\.00/);
  assert.match(html, /1,100 den-fire credits/);
  assert.match(html, /\(\+10%\)/);
  assert.match(html, /Continue to secure checkout — \$10\.00/);
  assert.match(html, /@review-wolf/); // buying-as line
  assert.match(html, /AllScale/);
  assert.match(html, /FROM The Beast/); // expectation-setting for the hosted page
  assert.match(html, /1\.00 USDC = \$1\.00/); // normie stablecoin explainer
  assert.match(html, /come back here automatically/i);
  assert.match(html, /pack_pay_ctx/); // writes order ctx for the return page
  assert.match(html, /changed my mind/);
  assert.match(html, /<title>Checkout — Ember pack · The Pack<\/title>/);
  for (const src of scriptsOf(html)) assert.doesNotThrow(() => new Function(src), "checkout inline script must parse");
});

test("/pay/checkout: from-context sanitized into page + cancel link; open-redirect dropped", async () => {
  const env = makeEnv();
  const { cookie } = await claimHuman(env, "ctx-wolf");
  const ok = await (await worker.fetch(req("/pay/checkout?pack=spark&from=/den/lobby", { headers: { cookie } }), env)).text();
  assert.match(ok, /href="\/pay\?from=%2Fden%2Flobby"/); // cancel preserves context
  assert.match(ok, /\\"from\\":\\"\/den\/lobby\\"/.source ? /\/den\/lobby/ : /never/);

  const evil = await (await worker.fetch(req(`/pay/checkout?pack=spark&from=${encodeURIComponent("//evil.com/x")}`, { headers: { cookie } }), env)).text();
  assert.doesNotMatch(evil, /evil\.com/);
  assert.match(evil, /href="\/pay"/); // cancel falls back to plain /pay
});

test("/pay: from plumbed into checkout links + back-to-den link; from sanitized", async () => {
  const env = makeEnv();
  const { cookie } = await claimHuman(env, "plumb-wolf");
  const html = await (await worker.fetch(req("/pay?from=/den/lobby", { headers: { cookie } }), env)).text();
  assert.match(html, /href="\/pay\/checkout\?pack=spark&amp;from=%2Fden%2Flobby"|href="\/pay\/checkout\?pack=spark&from=%2Fden%2Flobby"/);
  assert.match(html, /href="\/den\/lobby">← back to your den/);

  const evil = await (await worker.fetch(req(`/pay?from=${encodeURIComponent("javascript:alert(1)")}`, { headers: { cookie } }), env)).text();
  assert.doesNotMatch(evil, /javascript:alert/);
  assert.match(evil, /href="\/pay\/checkout\?pack=spark"/);
});

test("create-intent: redirect_url follows HOSTNAME; order_ref leaks no user id; description Pack-branded", async () => {
  const env = makeEnv();
  const { cookie } = await claimHuman(env, "ref-wolf");
  const uid = env.DB._tables.users.find((u) => u.handle === "ref-wolf").id;
  let sent = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({ code: 0, payload: { checkout_url: "https://app.allscale.io/pay/checkout/abc123", allscale_checkout_intent_id: "chk_ux_1" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const res = await worker.fetch(
      req("/api/payments/allscale/create-intent", { method: "POST", headers: { ...jsonHeaders, cookie, "cf-connecting-ip": nextIp() }, body: JSON.stringify({ pack: "spark" }) }),
      env,
    );
    assert.equal(res.status, 201);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(sent.body.redirect_url, "https://pack.test/pay/thanks"); // HOSTNAME-derived
  assert.match(sent.body.order_id, /^pack:[0-9a-f-]{36}$/);
  assert.ok(!sent.body.order_id.includes(uid), "payer-visible order id must not embed the user UUID");
  assert.match(sent.body.order_description, /The Pack/);
  assert.match(sent.body.order_description, /Spark/);
});

test("/pay/thanks: state containers + honest attribution + scripts parse", async () => {
  const env = makeEnv();
  const { cookie } = await claimHuman(env, "thx-wolf");
  const html = await (await worker.fetch(req("/pay/thanks", { headers: { cookie } }), env)).text();
  assert.match(html, /id="thx-progress"/);
  assert.match(html, /id="thx-success"/);
  assert.match(html, /id="thx-retry"/);
  assert.match(html, /id="thx-den-cta"/); // back-to-your-den CTA
  assert.match(html, /Secure checkout by AllScale/); // continuity attribution
  assert.match(html, /pack_pay_ctx/);
  assert.doesNotMatch(html, /Thank you 🔥/); // old static hero retired
  for (const src of scriptsOf(html)) assert.doesNotThrow(() => new Function(src), "thanks inline script must parse");
});
