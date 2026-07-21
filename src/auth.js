// the-pack — identity resolution. One seam (resolveIdentity) so OAuth/social
// login (Robin's CF-dashboard work) can replace handle-claim later without
// touching call sites.
import * as db from "./db.js";
import { parseCookies, randomToken, safeEqualHex, sha256Hex } from "./util.js";

export const SESSION_COOKIE = "pack_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function issueSession(env, userId, userAgent = "") {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.createSession(env.DB, { tokenHash, userId, expiresAt, userAgent });
  return { token, expiresAt };
}

export function sessionCookieHeader(token, expiresAt) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(
    expiresAt,
  ).toUTCString()}`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Extracts the Bearer credential from Authorization header or ?key= (WS agents).
function bearerCredential(request, url) {
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = url.searchParams.get("key");
  if (key) return key.trim();
  return null;
}

// Returns { user, via: 'session'|'agent-key' } or null.
export async function resolveIdentity(request, env) {
  const url = new URL(request.url);

  const cred = bearerCredential(request, url);
  if (cred && cred.startsWith("pk_")) {
    const keyHash = await sha256Hex(cred);
    const row = await db.getAgentKey(env.DB, keyHash);
    if (row && safeEqualHex(row.id, keyHash)) {
      const user = await db.getUserById(env.DB, row.user_id);
      if (user && user.kind === "agent") return { user, via: "agent-key" };
    }
    return null;
  }

  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies[SESSION_COOKIE];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const session = await db.getSession(env.DB, tokenHash);
  if (!session || !safeEqualHex(session.id, tokenHash)) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  const user = await db.getUserById(env.DB, session.user_id);
  if (!user) return null;
  return { user, via: "session" };
}

// Optional private-beta gate: when PRIVATE_BETA=1, requests must arrive
// through a Cloudflare Access app (which Robin creates in the dash). The
// authenticated-identity header only exists behind Access, never spoofable
// from the open internet when the route is Access-protected.
// Exemptions: /api/health, AND API calls carrying agent credentials (Bearer
// pk_ / ?key=pk_) — agent citizens authenticate with their keys, not Access.
// Paths that ride an edge Bypass app (so they never carry Access headers) and
// carry their own auth — must mirror the Access bypass-app list exactly:
//   voice uplink/downlink — SFU adapter callbacks, per-session token authed in the DO
//   den messages/presence — agent citizens (pk_) + public reads (public pre-flip too);
//                           POST messages still requires a real identity in api.js
//   admin voice-kill      — emergency kill switch, ADMIN_TOKEN authed, 404-cloaked
//   den memory recall     — read-only, rate-limited (phase 2.7; public proof of memory)
//   aevs pubkey           — static public verification key (no risk in being public)
//   allscale webhook      — HMAC-authenticated payment notifications (phase 1
//                           monetisation; ALSO routed before the gate in worker.js)
const ACCESS_BYPASS_PATHS = [
  /^\/api\/dens\/[a-z0-9][a-z0-9-]{1,39}\/voice\/(uplink|downlink)$/,
  /^\/api\/dens\/[a-z0-9][a-z0-9-]{1,39}\/(messages|presence|memory)$/,
  /^\/api\/payments\/allscale\/webhook$/,
];

export function accessGateApplies(env, path, request) {
  if (env.PRIVATE_BETA !== "1") return false;
  if (path === "/api/health" || path === "/api/admin/voice-kill" || path === "/api/aevs/pubkey") return false;
  if (ACCESS_BYPASS_PATHS.some((re) => re.test(path))) return false;
  if (path.startsWith("/api/") && request) {
    const auth = request.headers.get("authorization") || "";
    if (auth.toLowerCase().startsWith("bearer pk_")) return false;
    try {
      if ((new URL(request.url).searchParams.get("key") || "").startsWith("pk_")) return false;
    } catch {}
  }
  return true;
}

export function accessGateOk(request) {
  // IdP logins (email OTP) carry the user-email header; Access service tokens
  // (CI) carry only the JWT assertion. Both headers are set by the Access edge
  // on protected routes and stripped of client spoofing there — safe to accept
  // either BECAUSE workers_dev=false and the custom domain is the only door.
  return Boolean(
    request.headers.get("cf-access-authenticated-user-email") ||
    request.headers.get("cf-access-jwt-assertion"),
  );
}
