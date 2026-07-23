// the-pack — pluggable transactional email sender (native auth, M1/M2).
// DEFAULT PROVIDER: Cloudflare Email Service ("Email Sending", public beta
// 2026-04, Workers Paid) via the native `send_email` binding — no API keys,
// no secrets, structured send() does the MIME for us (the EmailMessage +
// mimetext dance is the LEGACY path; not needed). Robin picked this 2026-07-23.
//
// Provider matrix (EMAIL_PROVIDER var; unset ⇒ "cloudflare"):
//   cloudflare — env.EMAIL send_email binding + EMAIL_FROM (verified sending
//                domain required at runtime: E_SENDER_NOT_VERIFIED /
//                E_SENDER_DOMAIN_NOT_AVAILABLE until Robin onboards one)
//   resend     — documented FALLBACK provider (EMAIL_API_KEY secret +
//                EMAIL_FROM); written, never live-tested
//   stub       — D1 dev_outbox only (dev/preview; read back via the
//                ADMIN_TOKEN-gated /api/admin/dev-mail)
//
// EMAIL_STUB_FALLBACK="1" (PREVIEW-ONLY var): when the cloudflare provider is
// unusable (binding absent, domain unverified, send error) the code drops into
// the stub outbox instead of failing — loudly self-identified in /api/health
// and by the login-page DEV MAIL banner. WITHOUT this var the sender stays
// fail-closed (prod must never silently swallow sign-in codes).
import * as db from "./db.js";

export function emailProvider(env) {
  return (env.EMAIL_PROVIDER || "cloudflare").trim().toLowerCase();
}

function cfEmailReady(env) {
  return Boolean(env.EMAIL && typeof env.EMAIL.send === "function" && env.EMAIL_FROM);
}

export function emailStubFallbackArmed(env) {
  return env.EMAIL_STUB_FALLBACK === "1";
}

/** Truthy iff /api/auth/start can produce a code SOMEWHERE (real or dev outbox). */
export function emailConfigured(env) {
  const p = emailProvider(env);
  if (p === "stub") return true;
  if (p === "cloudflare") return cfEmailReady(env) || emailStubFallbackArmed(env);
  if (p === "resend") return Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM);
  return false;
}

/** Health-line label. Anything stub-ish contains "stub" — the login page's
 *  DEV MAIL banner and E2E health checks key off that. */
export function emailStatus(env) {
  // Nothing set anywhere (typical access-mode/prod-today env): report the
  // plain truth rather than "cloudflare (missing …)" noise for a provider
  // nobody chose yet on that deployment.
  if (!env.EMAIL_PROVIDER && !env.EMAIL && !env.EMAIL_FROM && !emailStubFallbackArmed(env)) return "unconfigured";
  const p = emailProvider(env);
  if (p === "stub") return "stub (dev-only outbox — NOT real mail)";
  if (p === "cloudflare") {
    if (cfEmailReady(env)) {
      return emailStubFallbackArmed(env)
        ? "cloudflare (send_email binding; stub-fallback ARMED — dev only)"
        : "cloudflare (send_email binding)";
    }
    return emailStubFallbackArmed(env)
      ? "cloudflare UNAVAILABLE → stub fallback (dev outbox — NOT real mail)"
      : "cloudflare (missing send_email binding or EMAIL_FROM — fail-closed)";
  }
  if (p === "resend") {
    return emailConfigured(env) ? "resend" : "resend (missing key/from — fail-closed)";
  }
  return "unconfigured";
}

/** Send an auth code. Returns { ok, reason? }. Fail-closed: an unusable
 *  provider is a refusal, never a silent success — unless the PREVIEW-ONLY
 *  stub fallback is armed, which is loud by construction. */
export async function sendAuthCode(env, { to, code }) {
  const subject = "Your Pack sign-in code";
  // Deliberately plain ASCII text/plain: OTP mail wants deliverability, not art.
  const text = `${code} is your one-time code for The Pack.\n\nIt expires in 10 minutes. If you didn't request it, ignore this email - nothing happens without the code.`;
  const p = emailProvider(env);
  if (p === "stub") return sendViaStub(env, { to, subject, text });
  if (p === "cloudflare") {
    if (cfEmailReady(env)) {
      const sent = await sendViaCloudflareEmail(env, { to, subject, text });
      if (sent.ok) return sent;
      if (emailStubFallbackArmed(env)) {
        console.log(`[email] cloudflare send failed (${sent.reason}) → STUB FALLBACK (dev outbox, preview-only)`);
        return sendViaStub(env, { to, subject, text });
      }
      return sent;
    }
    if (emailStubFallbackArmed(env)) {
      console.log("[email] cloudflare binding/EMAIL_FROM absent → STUB FALLBACK (dev outbox, preview-only)");
      return sendViaStub(env, { to, subject, text });
    }
    return { ok: false, reason: "email_unconfigured" };
  }
  if (p === "resend") return sendViaResend(env, { to, subject, text });
  return { ok: false, reason: "email_unconfigured" };
}

// ── Cloudflare Email Service (send_email binding) — THE default ────────────
// Structured builder API: the platform renders the MIME, signs DKIM on the
// onboarded domain's cf-bounce selector, and returns {messageId}. Errors are
// thrown with a .code (E_SENDER_NOT_VERIFIED, E_RATE_LIMIT_EXCEEDED,
// E_DAILY_LIMIT_EXCEEDED, …) — surfaced in `reason` for the caller/logs.
async function sendViaCloudflareEmail(env, { to, subject, text }) {
  try {
    const res = await env.EMAIL.send({
      to,
      from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME || "The Pack" },
      subject,
      text,
    });
    return { ok: true, id: res?.messageId };
  } catch (err) {
    return { ok: false, reason: `cf_email_${(err && err.code) || "error"}` };
  }
}

// Dev/preview stub: the "mail" lands in D1 dev_outbox + worker log. Codes in
// logs are acceptable ONLY because this path is preview-gated by config.
async function sendViaStub(env, { to, subject, text }) {
  try {
    await db.insertDevMail(env.DB, { email: to, subject, body: text });
    console.log(`[dev-mail] to=${to} subject=${JSON.stringify(subject)} (code in dev_outbox)`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "stub_write_failed" };
  }
}

// Documented fallback provider (Resend HTTPS API). UNTESTED live — kept so a
// provider swap stays config-only if Email Sending beta ever misbehaves.
async function sendViaResend(env, { to, subject, text }) {
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) return { ok: false, reason: "email_unconfigured" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
    });
    if (!res.ok) return { ok: false, reason: `resend_http_${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, reason: "resend_unreachable" };
  }
}
