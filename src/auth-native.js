// the-pack — Workers-native email-OTP auth (M1, 2026-07-23 architecture §3).
// Replaces the CF Access edge as the email VERIFIER while reusing the entire
// v0.8.0 "email = permanent account key" machinery (recoverUserByEmail,
// issueSession, migration 0009 unique index) verbatim. Active only when
// AUTH_MODE="native"; in "access" mode these endpoints 404 and behavior is
// byte-for-byte the pre-M1 worker.
//
// Storage rule: OTP challenges live in D1 (strong consistency), never KV.
// Fail-closed rule: missing Turnstile secret or email provider ⇒ 503 on
// /api/auth/start; existing sessions keep working (mirrors payments/grok).
import * as db from "./db.js";
import { authMode, issueSession, recoverUserByEmail, sessionCookieHeader } from "./auth.js";
import { emailConfigured, sendAuthCode } from "./email.js";
import { apiError, clampStr, clientIp, json, randomToken, safeEqualHex, sha256Hex, softRateLimit } from "./util.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const OTP_TTL_MS = 10 * 60 * 1000; // code lifetime
const CLAIM_TTL_MS = 15 * 60 * 1000; // claim-ticket lifetime
const OTP_MAX_ATTEMPTS = 5; // then the challenge is burned
// Global hard fuses (D1-counted — real limits, unlike per-isolate softRateLimit):
const SENDS_PER_EMAIL_HOUR = 3;
const SENDS_PER_IP_HOUR = 10;
const SENDS_GLOBAL_DAY = 2000; // mail-bomb circuit breaker

// Cloudflare's DOCUMENTED test keys (developers.cloudflare.com/turnstile/
// troubleshooting/testing/). They always pass/fail regardless of the token —
// dev/preview only. Health + login page banner make their presence loud.
const TURNSTILE_TEST_SITE_KEYS = new Set([
  "1x00000000000000000000AA", // visible, always passes
  "2x00000000000000000000AB", // visible, always blocks
  "1x00000000000000000000BB", // invisible, always passes
  "2x00000000000000000000BB", // invisible, always blocks
  "3x00000000000000000000FF", // visible, forces interactive challenge
]);
const TURNSTILE_TEST_SECRET_KEYS = new Set([
  "1x0000000000000000000000000000000AA", // always passes
  "2x0000000000000000000000000000000AA", // always fails
  "3x0000000000000000000000000000000AA", // token already spent
]);

export function turnstileSiteKey(env) {
  return (env.TURNSTILE_SITE_KEY || "").trim();
}

export function turnstileIsTestKeys(env) {
  return (
    TURNSTILE_TEST_SITE_KEYS.has(turnstileSiteKey(env)) ||
    TURNSTILE_TEST_SECRET_KEYS.has((env.TURNSTILE_SECRET_KEY || "").trim())
  );
}

/** "missing" | "test-keys (always-pass — dev only)" | "ok" */
export function turnstileStatus(env) {
  if (!env.TURNSTILE_SECRET_KEY || !turnstileSiteKey(env)) return "missing";
  if (turnstileIsTestKeys(env)) return "test-keys (always-pass — dev only)";
  return "ok";
}

// Server-side siteverify. Fail-closed: any network/parse hiccup = not human.
async function verifyTurnstile(env, token, ip) {
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
    });
    const data = await res.json();
    return Boolean(data && data.success);
  } catch {
    return false;
  }
}

// Unbiased 6-digit code (rejection sampling — no modulo bias).
function mintCode() {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4_000_000_000) return String(buf[0] % 1_000_000).padStart(6, "0");
  }
}

function normEmail(v) {
  const email = clampStr(v, 120).toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

async function readJson(request) {
  const text = await request.text().catch(() => "");
  if (text.length > 8 * 1024) return null;
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

// ── POST /api/auth/start {email, turnstileToken} ──────────────────────────
// Response is a flat {ok:true} for known AND unknown emails (no
// account-existence oracle). Refusals are config (503), bot (403) or rate
// (429) — none reveal account state.
export async function handleAuthStart(request, env) {
  if (authMode(env) !== "native") return apiError(404, "not_found", "Not found.");
  if (!softRateLimit(`authstart:${clientIp(request)}`, 30, 3600_000)) {
    return apiError(429, "rate_limited", "Too many code requests from this network. Try later.");
  }
  if (turnstileStatus(env) === "missing" || !emailConfigured(env)) {
    return apiError(503, "auth_unconfigured", "Sign-in isn't fully configured on this deployment yet. Existing sessions keep working.");
  }
  const body = await readJson(request);
  if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
  const email = normEmail(body.email);
  if (!email) return apiError(400, "bad_email", "That email doesn't look right.");
  const token = clampStr(body.turnstileToken, 2048);
  if (!token || !(await verifyTurnstile(env, token, clientIp(request)))) {
    return apiError(403, "turnstile_failed", "The bot check didn't pass — reload and try again.");
  }

  // Hard send fuses (D1 rows = ledger; strong consistency > throughput here).
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  if ((await db.countAuthSends(env.DB, { email, since: hourAgo })) >= SENDS_PER_EMAIL_HOUR) {
    return apiError(429, "rate_limited", "Too many codes for that email this hour — check your inbox (and spam) for the last one.");
  }
  if ((await db.countAuthSends(env.DB, { ip: clientIp(request), since: hourAgo })) >= SENDS_PER_IP_HOUR) {
    return apiError(429, "rate_limited", "Too many code requests from this network. Try later.");
  }
  if ((await db.countAuthSends(env.DB, { since: dayAgo })) >= SENDS_GLOBAL_DAY) {
    console.log("[auth] GLOBAL OTP SEND FUSE TRIPPED — investigate before raising");
    return apiError(503, "send_fuse", "The gate is cooling down — try again later.");
  }

  const code = mintCode();
  // A new request supersedes any older pending code for this email.
  await db.invalidateAuthChallenges(env.DB, "otp", email);
  await db.createAuthChallenge(env.DB, {
    id: crypto.randomUUID(),
    kind: "otp",
    email,
    codeHash: await sha256Hex(code),
    ip: clientIp(request),
    expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
  });
  const sent = await sendAuthCode(env, { to: email, code });
  if (!sent.ok) return apiError(503, "email_send_failed", "Couldn't send the code right now — try again in a minute.");
  return json({ ok: true, sent: true });
}

// ── POST /api/auth/verify {email, code} ───────────────────────────────────
// On success the email is worker-verified — exactly the trust the Access
// header used to carry — and the v0.8.0 seam takes over:
//   bound/legacy email → session for THAT account (login = recovery = new device)
//   no account         → one-time claim ticket for POST /api/handles
export async function handleAuthVerify(request, env) {
  if (authMode(env) !== "native") return apiError(404, "not_found", "Not found.");
  if (!softRateLimit(`authverify:${clientIp(request)}`, 60, 3600_000)) {
    return apiError(429, "rate_limited", "Too many attempts from this network. Try later.");
  }
  const body = await readJson(request);
  if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
  const email = normEmail(body.email);
  const code = clampStr(body.code, 6);
  // One opaque failure message for every reject — no oracle on WHY.
  const reject = () => apiError(400, "code_invalid", "That code is wrong or expired — request a new one.");
  if (!email || !/^[0-9]{6}$/.test(code)) return reject();

  const ch = await db.getActiveAuthChallenge(env.DB, "otp", email);
  if (!ch || new Date(ch.expires_at).getTime() < Date.now()) return reject();
  if (ch.attempts >= OTP_MAX_ATTEMPTS) return reject(); // burned — must restart
  await db.bumpAuthChallengeAttempts(env.DB, ch.id); // write-first accounting
  if (!safeEqualHex(await sha256Hex(code), ch.code_hash)) return reject();
  if (!(await db.consumeAuthChallenge(env.DB, ch.id))) return reject(); // raced double-verify

  const user = await recoverUserByEmail(env, email); // 0009 seam, verbatim
  if (user) {
    await db.touchUser(env.DB, user.id);
    const { token, expiresAt } = await issueSession(env, user.id, request.headers.get("user-agent") || "");
    return json(
      { ok: true, user: db.publicUser(user), recovered: true },
      { headers: { "set-cookie": sessionCookieHeader(token, expiresAt) } },
    );
  }

  // No account yet: mint a one-time claim ticket proving email ownership to
  // exactly one handle claim (anti-squat is structural, not decorative).
  const ticket = randomToken(24);
  await db.createAuthChallenge(env.DB, {
    id: await sha256Hex(ticket),
    kind: "claim",
    email,
    codeHash: await sha256Hex(ticket),
    ip: clientIp(request),
    expiresAt: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
  });
  return json({ ok: true, needsClaim: true, claimTicket: ticket, email });
}

// ── claim tickets (used by /api/handles and /api/session/recover) ─────────
/** Validate WITHOUT consuming; returns the challenge row (email inside) or null. */
export async function peekClaimTicket(env, ticket) {
  const t = clampStr(ticket, 128);
  if (!/^[0-9a-f]{48}$/.test(t)) return null;
  const row = await db.getAuthChallengeById(env.DB, await sha256Hex(t));
  if (!row || row.kind !== "claim" || row.consumed_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/** One-time consume by row id; false when a race already spent it. */
export async function consumeClaimTicket(env, rowId) {
  return db.consumeAuthChallenge(env.DB, rowId);
}
