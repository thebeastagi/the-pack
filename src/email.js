// the-pack — pluggable transactional email sender (native auth, M1).
// Cloudflare has no GA outbound-email primitive for arbitrary transactional
// mail, so OTP delivery is the ONE non-CF box in the target architecture.
// Robin decision R1 (provider + sending domain + SPF/DKIM/DMARC) is pending;
// until then EMAIL_PROVIDER="stub" writes the mail into the D1 dev_outbox
// (read back via the ADMIN_TOKEN-gated /api/admin/dev-mail) so the full flow
// is E2E-testable with zero external dependencies.
//
// Swapping in the real provider is ONE function + two env values:
//   EMAIL_PROVIDER="resend" (or add a sendVia<Provider>() sibling)
//   EMAIL_API_KEY  — wrangler secret put (never a var, never committed)
//   EMAIL_FROM     — e.g. "The Pack <gate@mail.thebeastagi.com>"
import * as db from "./db.js";

export function emailProvider(env) {
  return (env.EMAIL_PROVIDER || "").trim().toLowerCase();
}

/** Truthy iff a sender is usable. "stub" is always usable (dev/preview only). */
export function emailConfigured(env) {
  const p = emailProvider(env);
  if (p === "stub") return true;
  if (p === "resend") return Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM);
  return false;
}

/** Health-line label; makes stub deployments loudly self-identifying. */
export function emailStatus(env) {
  const p = emailProvider(env);
  if (!p) return "unconfigured";
  if (p === "stub") return "stub (dev-only outbox — NOT real mail)";
  return emailConfigured(env) ? p : `${p} (missing key/from — fail-closed)`;
}

/** Send an auth code. Returns { ok, reason? }. Fail-closed: unknown/missing
 *  provider is a refusal, never a silent success. */
export async function sendAuthCode(env, { to, code }) {
  const subject = "Your Pack sign-in code";
  const text = `${code} is your one-time code for The Pack.\n\nIt expires in 10 minutes. If you didn't request it, ignore this email — nothing happens without the code.`;
  const p = emailProvider(env);
  if (p === "stub") return sendViaStub(env, { to, subject, text });
  if (p === "resend") return sendViaResend(env, { to, subject, text });
  return { ok: false, reason: "email_unconfigured" };
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

// Real provider (Resend HTTPS API). UNTESTED until R1 lands a key — kept here
// so the prod flip is config-only. Sibling providers (SES/Postmark) would be
// one more function of this exact shape.
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
