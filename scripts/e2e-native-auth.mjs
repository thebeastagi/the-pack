#!/usr/bin/env node
// the-pack — live E2E for Workers-native email-OTP auth (M1/M2), zero deps.
// Runs against a NATIVE-mode deployment with EMAIL_PROVIDER=stub (the OTP
// "mail" is read back from the dev outbox — no real mailbox needed).
//
//   PACK_BASE=https://pack-preview.thebeastagi.com \
//   CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… \   (edge Access app, if any)
//   PACK_ADMIN_TOKEN=… node scripts/e2e-native-auth.mjs
//
// Steps: health → start(code) → dev-mail → wrong code → verify(needsClaim)
// → claim without ticket refused → claim with ticket → me → cookie loss →
// start+verify again lands SAME handle → header-spoof probes → summary.
// Test residue: one user named load-na-<rand> (load-* cleanup convention).

const BASE = process.env.PACK_BASE || "https://pack-preview.thebeastagi.com";
const ADMIN = process.env.PACK_ADMIN_TOKEN || "";
const SVC = process.env.CF_ACCESS_CLIENT_ID
  ? { "cf-access-client-id": process.env.CF_ACCESS_CLIENT_ID, "cf-access-client-secret": process.env.CF_ACCESS_CLIENT_SECRET }
  : {};

const rand = Math.random().toString(36).slice(2, 8);
const EMAIL = `pack-native-e2e-${rand}@example.net`; // stub sender: never leaves D1
const HANDLE = `load-na-${rand}`;

const results = [];
function step(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    console.log("\nFAIL — aborting");
    process.exit(1);
  }
}

async function call(path, { method = "GET", body = null, cookie = "", headers = {} } = {}) {
  const h = { ...SVC, ...headers };
  if (body !== null) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body === null ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.clone().json(); } catch { data = { _text: (await res.text()).slice(0, 200) }; }
  return { res, data, cookie: (res.headers.get("set-cookie") || "").split(";")[0] || null };
}

async function getCode() {
  // dev outbox is eventually written before /start returns; retry is just politeness
  for (let i = 0; i < 5; i++) {
    const { data } = await call(`/api/admin/dev-mail?email=${encodeURIComponent(EMAIL)}`, { headers: { "x-admin-token": ADMIN } });
    const m = data?.mail?.[0]?.body?.match(/\b(\d{6})\b/);
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const start = () => call("/api/auth/start", { method: "POST", body: { email: EMAIL, turnstileToken: "e2e-dummy-token-test-keys-accept-anything" } });

// ── run ────────────────────────────────────────────────────────────────────
console.log(`e2e-native-auth vs ${BASE} as ${EMAIL} → @${HANDLE}\n`);

{
  const { res, data } = await call("/api/health");
  step("health: native mode + stub email + test-keys turnstile", res.ok && data?.auth?.mode === "native" && /stub/.test(data?.auth?.email || "") && /test-keys|ok/.test(data?.auth?.turnstile || ""), JSON.stringify(data?.auth));
}
{
  const { res, data } = await start();
  step("auth/start accepts email (flat ok)", res.status === 200 && data?.ok === true && !("account" in data), JSON.stringify(data));
}
const code1 = await getCode();
step("dev outbox delivered a 6-digit code", Boolean(code1));
{
  const wrong = code1 === "000000" ? "000001" : "000000";
  const { res, data } = await call("/api/auth/verify", { method: "POST", body: { email: EMAIL, code: wrong } });
  step("wrong code → 400 code_invalid", res.status === 400 && data?.error?.code === "code_invalid");
}
let ticket = null;
{
  const { res, data } = await call("/api/auth/verify", { method: "POST", body: { email: EMAIL, code: code1 } });
  ticket = data?.claimTicket || null;
  step("verify → needsClaim + claim ticket, no premature cookie", res.status === 200 && data?.needsClaim === true && /^[0-9a-f]{48}$/.test(ticket || ""));
}
{
  const { res, data } = await call("/api/handles", { method: "POST", body: { handle: `${HANDLE}-squat` } });
  step("claim WITHOUT ticket refused (anti-squat)", res.status === 403 && data?.error?.code === "claim_ticket_required");
}
let cookie1 = null;
{
  const { res, data, cookie } = await call("/api/handles", { method: "POST", body: { handle: HANDLE, claimTicket: ticket } });
  cookie1 = cookie;
  step("claim WITH ticket → 201, emailBound, session cookie", res.status === 201 && data?.emailBound === true && /^pack_session=[0-9a-f]{64}/.test(cookie || ""));
}
{
  const { res, data } = await call("/api/me", { cookie: cookie1 });
  step("me: session lands as claimed handle", res.ok && data?.user?.handle === HANDLE && data?.emailBound === true);
}
{
  const { res, data } = await call("/api/handles", { method: "POST", body: { handle: `${HANDLE}-replay`, claimTicket: ticket } });
  step("ticket replay refused (one-time)", res.status === 403);
}
// cookie loss / new device: same email, fresh OTP → SAME account, no claim step
{
  const { res } = await start();
  step("re-login: auth/start again", res.status === 200);
}
const code2 = await getCode();
step("re-login: fresh code delivered", Boolean(code2) && code2 !== code1);
let cookie2 = null;
{
  const { res, data, cookie } = await call("/api/auth/verify", { method: "POST", body: { email: EMAIL.toUpperCase(), code: code2 } });
  cookie2 = cookie;
  step("re-login: verify → direct session, recovered, SAME @handle (case-insensitive email)", res.status === 200 && data?.recovered === true && data?.user?.handle === HANDLE && Boolean(cookie));
}
{
  const { res, data } = await call("/api/me", { cookie: cookie2 });
  step("re-login: new device session resolves to same account", res.ok && data?.user?.handle === HANDLE);
}
// header-spoof probes (worker-level guarantee is the hermetic test; this
// proves the deployed worker refuses header-borne identity in native mode —
// note an Access edge in front may ALSO strip the header before us).
{
  const { res, data } = await call("/api/session/recover", { method: "POST", body: {}, headers: { "cf-access-authenticated-user-email": EMAIL } });
  step("spoof: recover with forged cf-access header → 400, no session", res.status === 400 && data?.error?.code === "no_verified_email");
}
{
  const { res } = await call("/", { headers: { "cf-access-authenticated-user-email": EMAIL } });
  const setCookie = res.headers.get("set-cookie");
  step("spoof: page GET with forged header → no silent-resume cookie", res.status === 200 && !setCookie);
}

console.log(`\nALL ${results.length} STEPS PASS`);
console.log(`residue: user @${HANDLE} + stub mail rows for ${EMAIL} (load-* cleanup convention)`);
