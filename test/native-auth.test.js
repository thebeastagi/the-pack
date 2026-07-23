// the-pack — Workers-native email-OTP auth (M1). Hermetic: fake D1, stubbed
// Turnstile siteverify fetch, stub email provider (D1 dev_outbox).
// THE test that matters most here: in native mode the cf-access-* headers are
// RADIOACTIVE (client-spoofable once the Access app is off the domain) and
// must be ignored on every identity path.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeDoNamespace, createFakeR2, installWebSocketStubs } from "./fakes.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

const TEST_SITE_KEY = "1x00000000000000000000AA"; // CF documented always-pass
const TEST_SECRET_KEY = "1x0000000000000000000000000000000AA";

function makeEnv(overrides = {}) {
  const DB = createFakeD1();
  return {
    DB,
    DEN_ROOMS: createFakeDoNamespace({ DB }),
    MEDIA: createFakeR2(),
    ADMIN_TOKEN: "test-admin-token",
    PACK_VERSION: "test",
    PRIVATE_BETA: "0",
    ...overrides,
  };
}

const NATIVE = {
  AUTH_MODE: "native",
  EMAIL_PROVIDER: "stub",
  TURNSTILE_SITE_KEY: TEST_SITE_KEY,
  TURNSTILE_SECRET_KEY: TEST_SECRET_KEY,
};

let ipN = 0;
const nextIp = () => `10.7.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);
const jsonHeaders = { "content-type": "application/json" };

/** Stub fetch so Turnstile siteverify answers locally. */
function stubSiteverify(result = { success: true }) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("challenges.cloudflare.com/turnstile")) {
      if (result instanceof Error) throw result;
      return new Response(JSON.stringify(result), { status: 200 });
    }
    throw new Error(`unexpected external fetch in test: ${url}`);
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

function startReq(email, { ip = nextIp(), token = "test-pass-token" } = {}) {
  return req("/api/auth/start", {
    method: "POST",
    headers: { ...jsonHeaders, "cf-connecting-ip": ip },
    body: JSON.stringify({ email, turnstileToken: token }),
  });
}

function verifyReq(email, code, { ip = nextIp(), headers = {} } = {}) {
  return req("/api/auth/verify", {
    method: "POST",
    headers: { ...jsonHeaders, "cf-connecting-ip": ip, ...headers },
    body: JSON.stringify({ email, code }),
  });
}

function lastCodeFor(env, email) {
  const rows = env.DB._tables.dev_outbox.filter((m) => m.email === email);
  const m = rows[rows.length - 1]?.body.match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

async function startAndGetCode(env, email) {
  const res = await worker.fetch(startReq(email), env);
  assert.equal(res.status, 200, "auth/start should 200");
  assert.deepEqual(await res.json(), { ok: true, sent: true });
  const code = lastCodeFor(env, email);
  assert.match(code || "", /^\d{6}$/, "stub outbox must contain the code");
  return code;
}

// ── mode gating ────────────────────────────────────────────────────────────
test("access mode: native endpoints are 404 and health says mode=access", async () => {
  const env = makeEnv();
  for (const p of ["/api/auth/start", "/api/auth/verify"]) {
    const res = await worker.fetch(req(p, { method: "POST", headers: jsonHeaders, body: "{}" }), env);
    assert.equal(res.status, 404, p);
  }
  // dev-mail is cloaked when the stub provider isn't configured
  const dm = await worker.fetch(req("/api/admin/dev-mail?email=a@b.co", { headers: { "x-admin-token": "test-admin-token" } }), env);
  assert.equal(dm.status, 404);
  const health = await (await worker.fetch(req("/api/health"), env)).json();
  assert.equal(health.auth.mode, "access");
});

test("native mode fail-closed: missing turnstile/email config → 503, sessions keep working", async () => {
  const sv = stubSiteverify();
  try {
    for (const broken of [
      { ...NATIVE, TURNSTILE_SECRET_KEY: undefined },
      { ...NATIVE, TURNSTILE_SITE_KEY: undefined },
      { ...NATIVE, EMAIL_PROVIDER: undefined },
      { ...NATIVE, EMAIL_PROVIDER: "resend" }, // resend without key/from = unconfigured
    ]) {
      const env = makeEnv(broken);
      const res = await worker.fetch(startReq("wolf@example.net"), env);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, "auth_unconfigured");
    }
  } finally {
    sv.restore();
  }
});

// ── turnstile ───────────────────────────────────────────────────────────────
test("turnstile: reject (success:false) and network failure both fail closed", async () => {
  let sv = stubSiteverify({ success: false, "error-codes": ["invalid-input-response"] });
  try {
    const env = makeEnv(NATIVE);
    const res = await worker.fetch(startReq("bot@example.net"), env);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "turnstile_failed");
    assert.equal(env.DB._tables.auth_challenges.length, 0, "no challenge minted for bots");
  } finally {
    sv.restore();
  }
  sv = stubSiteverify(new Error("siteverify down"));
  try {
    const env = makeEnv(NATIVE);
    const res = await worker.fetch(startReq("net@example.net"), env);
    assert.equal(res.status, 403);
  } finally {
    sv.restore();
  }
});

test("health in native test config declares itself loudly", async () => {
  const env = makeEnv(NATIVE);
  const health = await (await worker.fetch(req("/api/health"), env)).json();
  assert.equal(health.auth.mode, "native");
  assert.match(health.auth.turnstile, /test-keys/);
  assert.match(health.auth.email, /stub/);
});

// ── full flow ───────────────────────────────────────────────────────────────
test("native signup: start → code → verify(needsClaim) → claim binds email; ticket is one-time", async () => {
  const sv = stubSiteverify();
  try {
    const env = makeEnv(NATIVE);
    const email = "new-wolf@example.net";
    const code = await startAndGetCode(env, email);

    // wrong code first: opaque reject, attempts counted
    const bad = await worker.fetch(verifyReq(email, "000001"), env);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "code_invalid");

    const ver = await worker.fetch(verifyReq(email, code), env);
    const vbody = await ver.json();
    assert.equal(ver.status, 200);
    assert.equal(vbody.needsClaim, true);
    assert.match(vbody.claimTicket, /^[0-9a-f]{48}$/);
    assert.equal(ver.headers.get("set-cookie"), null, "no session before claim");

    // claim WITHOUT ticket refused (anti-squat structural)
    const noTicket = await worker.fetch(
      req("/api/handles", { method: "POST", headers: { ...jsonHeaders, "cf-connecting-ip": nextIp() }, body: JSON.stringify({ handle: "squatter" }) }),
      env,
    );
    assert.equal(noTicket.status, 403);
    assert.equal((await noTicket.json()).error.code, "claim_ticket_required");

    // claim WITH ticket → account bound to the OTP-verified email
    const claim = await worker.fetch(
      req("/api/handles", {
        method: "POST",
        headers: { ...jsonHeaders, "cf-connecting-ip": nextIp() },
        body: JSON.stringify({ handle: "new-wolf", claimTicket: vbody.claimTicket }),
      }),
      env,
    );
    const cbody = await claim.json();
    assert.equal(claim.status, 201);
    assert.equal(cbody.emailBound, true);
    const u = env.DB._tables.users.find((x) => x.handle === "new-wolf");
    assert.equal(u.email, email);
    assert.ok(u.email_verified_at);
    const cookie = claim.headers.get("set-cookie").split(";")[0];
    const me = await (await worker.fetch(req("/api/me", { headers: { cookie } }), env)).json();
    assert.equal(me.user.handle, "new-wolf");

    // ticket burned: a second claim with it is refused
    const replay = await worker.fetch(
      req("/api/handles", {
        method: "POST",
        headers: { ...jsonHeaders, "cf-connecting-ip": nextIp() },
        body: JSON.stringify({ handle: "second-wolf", claimTicket: vbody.claimTicket }),
      }),
      env,
    );
    assert.equal(replay.status, 403);
    assert.equal(env.DB._tables.users.length, 1);
  } finally {
    sv.restore();
  }
});

test("native re-login: verify on a bound email issues a session directly (login = recovery = new device)", async () => {
  const sv = stubSiteverify();
  try {
    const env = makeEnv(NATIVE);
    const email = "return-wolf@example.net";
    // signup
    const code1 = await startAndGetCode(env, email);
    const t = (await (await worker.fetch(verifyReq(email, code1), env)).json()).claimTicket;
    await worker.fetch(
      req("/api/handles", { method: "POST", headers: { ...jsonHeaders, "cf-connecting-ip": nextIp() }, body: JSON.stringify({ handle: "return-wolf", claimTicket: t }) }),
      env,
    );
    // new device, no cookie: same email → same account, no claim step
    const code2 = await startAndGetCode(env, email);
    const res = await worker.fetch(verifyReq(email.toUpperCase(), code2), env); // case-insensitive
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.recovered, true);
    assert.equal(body.user.handle, "return-wolf");
    const cookie = res.headers.get("set-cookie").split(";")[0];
    const me = await (await worker.fetch(req("/api/me", { headers: { cookie } }), env)).json();
    assert.equal(me.user.handle, "return-wolf");
  } finally {
    sv.restore();
  }
});

test("legacy grandfather carries over: pre-cutoff typed email logs into the old account via native OTP", async () => {
  const sv = stubSiteverify();
  try {
    const env = makeEnv(NATIVE);
    env.DB._tables.users.push({
      id: "legacy-9", handle: "elder-wolf", display_name: "Elder", email: "elder@wolf.net",
      email_verified_at: null, kind: "human", created_at: "2026-07-20T00:00:00.000Z", last_seen_at: null,
    });
    const code = await startAndGetCode(env, "elder@wolf.net");
    const res = await worker.fetch(verifyReq("elder@wolf.net", code), env);
    const body = await res.json();
    assert.equal(body.user.handle, "elder-wolf");
    assert.ok(env.DB._tables.users.find((u) => u.id === "legacy-9").email_verified_at, "promoted");
  } finally {
    sv.restore();
  }
});

// ── abuse ceilings ──────────────────────────────────────────────────────────
test("code lockout: 5 wrong attempts burn the challenge; the right code no longer works", async () => {
  const sv = stubSiteverify();
  try {
    const env = makeEnv(NATIVE);
    const email = "brute@example.net";
    const code = await startAndGetCode(env, email);
    for (let i = 0; i < 5; i++) {
      const r = await worker.fetch(verifyReq(email, "111111"), env);
      assert.equal(r.status, 400);
    }
    const res = await worker.fetch(verifyReq(email, code), env);
    assert.equal(res.status, 400, "correct code after 5 misses must be dead");
  } finally {
    sv.restore();
  }
});

test("expired code rejects; per-email send fuse trips at 3/hr", async () => {
  const sv = stubSiteverify();
  try {
    const env = makeEnv(NATIVE);
    const email = "fuse@example.net";
    const code = await startAndGetCode(env, email);
    env.DB._tables.auth_challenges.at(-1).expires_at = new Date(Date.now() - 1000).toISOString();
    assert.equal((await worker.fetch(verifyReq(email, code), env)).status, 400);
    // sends 2 & 3 fine, 4th → 429 (distinct IPs so only the EMAIL fuse can trip)
    await startAndGetCode(env, email);
    await startAndGetCode(env, email);
    const res = await worker.fetch(startReq(email), env);
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, "rate_limited");
  } finally {
    sv.restore();
  }
});

test("a new code supersedes the old one for the same email", async () => {
  const sv = stubSiteverify();
  try {
    const env = makeEnv(NATIVE);
    const email = "super@example.net";
    const code1 = await startAndGetCode(env, email);
    const code2 = await startAndGetCode(env, email);
    if (code1 !== code2) {
      assert.equal((await worker.fetch(verifyReq(email, code1), env)).status, 400, "old code dead");
    }
    assert.equal((await worker.fetch(verifyReq(email, code2), env)).status, 200, "new code lives");
  } finally {
    sv.restore();
  }
});

// ── THE SPOOF TESTS: native mode must ignore cf-access-* headers ───────────
test("native mode ignores forged cf-access-authenticated-user-email EVERYWHERE", async () => {
  const sv = stubSiteverify();
  try {
    const env = makeEnv(NATIVE);
    // establish a bound account (the juicy spoof target)
    const email = "victim@example.net";
    const code = await startAndGetCode(env, email);
    const t = (await (await worker.fetch(verifyReq(email, code), env)).json()).claimTicket;
    await worker.fetch(
      req("/api/handles", { method: "POST", headers: { ...jsonHeaders, "cf-connecting-ip": nextIp() }, body: JSON.stringify({ handle: "victim-wolf", claimTicket: t }) }),
      env,
    );
    const forged = { "cf-access-authenticated-user-email": email };

    // 1) /api/session/recover with the forged header → NO session
    const rec = await worker.fetch(
      req("/api/session/recover", { method: "POST", headers: { ...forged, "cf-connecting-ip": nextIp() } }),
      env,
    );
    assert.equal(rec.status, 400);
    assert.equal((await rec.json()).error.code, "no_verified_email");
    assert.equal(rec.headers.get("set-cookie"), null);

    // 2) page GET with the forged header → NO silent resume, NO cookie
    const page = await worker.fetch(req("/", { headers: { ...forged, "cf-connecting-ip": nextIp() } }), env);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("set-cookie"), null, "silent resume must be dead in native mode");
    assert.doesNotMatch(await page.text(), /victim-wolf/);

    // 3) claim with forged header + no ticket → refused, nothing bound
    const claim = await worker.fetch(
      req("/api/handles", {
        method: "POST",
        headers: { ...jsonHeaders, ...forged, "cf-connecting-ip": nextIp() },
        body: JSON.stringify({ handle: "header-wolf" }),
      }),
      env,
    );
    assert.equal(claim.status, 403);
    assert.equal((await claim.json()).error.code, "claim_ticket_required");
    assert.equal(env.DB._tables.users.some((u) => u.handle === "header-wolf"), false);

    // 4) claim with a VALID ticket for A + forged header for B → binds A (ticket wins)
    const codeA = await startAndGetCode(env, "honest@example.net");
    const tA = (await (await worker.fetch(verifyReq("honest@example.net", codeA), env)).json()).claimTicket;
    const c2 = await worker.fetch(
      req("/api/handles", {
        method: "POST",
        headers: { ...jsonHeaders, "cf-access-authenticated-user-email": "attacker@evil.net", "cf-connecting-ip": nextIp() },
        body: JSON.stringify({ handle: "honest-wolf", claimTicket: tA }),
      }),
      env,
    );
    assert.equal(c2.status, 201);
    assert.equal(env.DB._tables.users.find((u) => u.handle === "honest-wolf").email, "honest@example.net");
  } finally {
    sv.restore();
  }
});

test("native mode: PRIVATE_BETA=1 no longer 403s headerless page GETs (worker is the gate)", async () => {
  const env = makeEnv({ ...NATIVE, PRIVATE_BETA: "1" });
  const res = await worker.fetch(req("/", { headers: { "cf-connecting-ip": nextIp() } }), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Enter the pack/);
});

// ── UI + CSP ────────────────────────────────────────────────────────────────
test("native home: gate card, turnstile widget + TEST banner, hidden claim, CSP allows challenges.cloudflare.com; scripts parse", async () => {
  const env = makeEnv(NATIVE);
  const res = await worker.fetch(req("/", { headers: { "cf-connecting-ip": nextIp() } }), env);
  const html = await res.text();
  assert.match(html, /id="gate"/);
  assert.match(html, new RegExp(`data-sitekey="${TEST_SITE_KEY}"`));
  assert.match(html, /TEST MODE — Turnstile/);
  assert.match(html, /id="claim-wrap" style="display:none"/);
  assert.match(html, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /script-src 'unsafe-inline' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
  for (const [, src] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new Function(src), "native home inline script must parse");
  }
  // access-mode home is byte-for-byte free of the gate + external script + CSP loosening
  const envAccess = makeEnv();
  const resA = await worker.fetch(req("/", { headers: { "cf-connecting-ip": nextIp() } }), envAccess);
  const htmlA = await resA.text();
  assert.doesNotMatch(htmlA, /id="gate"|challenges\.cloudflare\.com/);
  assert.doesNotMatch(resA.headers.get("content-security-policy"), /challenges\.cloudflare\.com/);
});

// ── dev outbox endpoint ─────────────────────────────────────────────────────
test("dev-mail: stub-only, admin-gated, returns the mail for one email", async () => {
  const sv = stubSiteverify();
  try {
    const env = makeEnv(NATIVE);
    await startAndGetCode(env, "peek@example.net");
    const noAuth = await worker.fetch(req("/api/admin/dev-mail?email=peek@example.net"), env);
    assert.equal(noAuth.status, 404, "cloaked without admin token");
    const res = await worker.fetch(
      req("/api/admin/dev-mail?email=peek@example.net", { headers: { "x-admin-token": "test-admin-token" } }),
      env,
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.mail.length, 1);
    assert.match(body.mail[0].body, /\b\d{6}\b/);
  } finally {
    sv.restore();
  }
});

// ── Cloudflare Email Service provider (send_email binding) ─────────────────
const CF_BASE = {
  AUTH_MODE: "native",
  EMAIL_PROVIDER: "cloudflare",
  EMAIL_FROM: "gate@pack.test",
  EMAIL_FROM_NAME: "The Pack",
  TURNSTILE_SITE_KEY: TEST_SITE_KEY,
  TURNSTILE_SECRET_KEY: TEST_SECRET_KEY,
};

/** Fake send_email binding. behavior: "ok" | "unverified" (throws with .code). */
function fakeEmailBinding(behavior = "ok") {
  const sent = [];
  return {
    sent,
    async send(msg) {
      sent.push(msg);
      if (behavior === "ok") return { messageId: `cf-msg-${sent.length}` };
      const err = new Error("sender domain not verified");
      err.code = "E_SENDER_NOT_VERIFIED";
      throw err;
    },
  };
}

test("cloudflare provider: start sends a structured message through the binding (no dev outbox), and the code verifies", async () => {
  const sv = stubSiteverify();
  try {
    const EMAILB = fakeEmailBinding("ok");
    const env = makeEnv({ ...CF_BASE, EMAIL: EMAILB });
    const email = "cfwolf@example.net";
    const res = await worker.fetch(startReq(email), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, sent: true });
    // exactly one binding send; correct structured fields; the platform does the MIME
    assert.equal(EMAILB.sent.length, 1);
    const msg = EMAILB.sent[0];
    assert.equal(msg.to, email);
    assert.deepEqual(msg.from, { email: "gate@pack.test", name: "The Pack" });
    assert.equal(msg.subject, "Your Pack sign-in code");
    const code = msg.text.match(/\b(\d{6})\b/)?.[1];
    assert.match(code || "", /^\d{6}$/, "text body carries the code");
    assert.equal(env.DB._tables.dev_outbox.length, 0, "real provider must not touch dev outbox");
    // the code sent through the binding is the live one
    const ver = await worker.fetch(verifyReq(email, code), env);
    assert.equal((await ver.json()).needsClaim, true);
    // health self-identifies
    const health = await (await worker.fetch(req("/api/health"), env)).json();
    assert.equal(health.auth.email, "cloudflare (send_email binding)");
  } finally {
    sv.restore();
  }
});

test("cloudflare provider fail-closed: binding missing or send error → 503 (no silent code loss)", async () => {
  const sv = stubSiteverify();
  try {
    // binding absent, no fallback armed
    let env = makeEnv(CF_BASE);
    let res = await worker.fetch(startReq("nofall@example.net"), env);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "auth_unconfigured");
    // binding present but domain unverified, no fallback armed
    env = makeEnv({ ...CF_BASE, EMAIL: fakeEmailBinding("unverified") });
    res = await worker.fetch(startReq("unver@example.net"), env);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "email_send_failed");
    assert.equal(env.DB._tables.dev_outbox.length, 0);
  } finally {
    sv.restore();
  }
});

test("cloudflare provider + EMAIL_STUB_FALLBACK=1 (preview): binding-absent AND send-error both drop into dev outbox, loudly", async () => {
  const sv = stubSiteverify();
  try {
    // binding absent → config-level fallback
    let env = makeEnv({ ...CF_BASE, EMAIL_STUB_FALLBACK: "1" });
    let res = await worker.fetch(startReq("fb1@example.net"), env);
    assert.equal(res.status, 200);
    assert.match(lastCodeFor(env, "fb1@example.net") || "", /^\d{6}$/);
    let health = await (await worker.fetch(req("/api/health"), env)).json();
    assert.match(health.auth.email, /stub fallback/);
    // binding present, domain unverified → runtime fallback; code still verifies
    const EMAILB = fakeEmailBinding("unverified");
    env = makeEnv({ ...CF_BASE, EMAIL: EMAILB, EMAIL_STUB_FALLBACK: "1" });
    res = await worker.fetch(startReq("fb2@example.net"), env);
    assert.equal(res.status, 200);
    assert.equal(EMAILB.sent.length, 1, "real send attempted first");
    const code = lastCodeFor(env, "fb2@example.net");
    assert.match(code || "", /^\d{6}$/);
    assert.equal((await worker.fetch(verifyReq("fb2@example.net", code), env)).status, 200);
    health = await (await worker.fetch(req("/api/health"), env)).json();
    assert.match(health.auth.email, /stub-fallback ARMED/);
  } finally {
    sv.restore();
  }
});

test("dev-mail endpoint tracks the stub sink: readable with fallback armed, cloaked for a healthy real binding", async () => {
  const sv = stubSiteverify();
  try {
    // fallback armed (binding absent): E2E must be able to read its codes
    let env = makeEnv({ ...CF_BASE, EMAIL_STUB_FALLBACK: "1" });
    await worker.fetch(startReq("sink@example.net"), env);
    let res = await worker.fetch(
      req("/api/admin/dev-mail?email=sink@example.net", { headers: { "x-admin-token": "test-admin-token" } }),
      env,
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mail.length, 1);
    // healthy real binding, no fallback: endpoint does not exist
    env = makeEnv({ ...CF_BASE, EMAIL: fakeEmailBinding("ok") });
    res = await worker.fetch(
      req("/api/admin/dev-mail?email=sink@example.net", { headers: { "x-admin-token": "test-admin-token" } }),
      env,
    );
    assert.equal(res.status, 404);
  } finally {
    sv.restore();
  }
});

test("DEV MAIL banner mirrors the sender truth (shown for stub-ish, absent for real binding)", async () => {
  // stub-ish (fallback armed, binding absent) → banner
  let env = makeEnv({ ...CF_BASE, EMAIL_STUB_FALLBACK: "1" });
  let html = await (await worker.fetch(req("/", { headers: { "cf-connecting-ip": nextIp() } }), env)).text();
  assert.match(html, /DEV MAIL MODE/);
  // healthy real binding, no fallback → no banner
  env = makeEnv({ ...CF_BASE, EMAIL: fakeEmailBinding("ok") });
  html = await (await worker.fetch(req("/", { headers: { "cf-connecting-ip": nextIp() } }), env)).text();
  assert.doesNotMatch(html, /DEV MAIL MODE/);
});

test("no account-existence oracle: start responds identically for bound and unknown emails", async () => {
  const sv = stubSiteverify();
  try {
    const env = makeEnv(NATIVE);
    // bound account
    const code = await startAndGetCode(env, "known@example.net");
    const t = (await (await worker.fetch(verifyReq("known@example.net", code), env)).json()).claimTicket;
    await worker.fetch(
      req("/api/handles", { method: "POST", headers: { ...jsonHeaders, "cf-connecting-ip": nextIp() }, body: JSON.stringify({ handle: "known-wolf", claimTicket: t }) }),
      env,
    );
    const a = await worker.fetch(startReq("known@example.net"), env);
    const b = await worker.fetch(startReq("nobody-here@example.net"), env);
    assert.equal(a.status, b.status);
    assert.deepEqual(await a.json(), await b.json());
  } finally {
    sv.restore();
  }
});
