// the-pack — Worker entry. Pages + REST + per-den WebSocket forwarding.
import { handleApi } from "./api.js";
import { accessGateApplies, accessGateOk, resolveIdentity } from "./auth.js";
import { getDenBySlug } from "./db.js";
import { DenRoom } from "./den-room.js";
import { VoiceDen } from "./voice/voice-den.js";
import { denPage, homePage, notFoundPage } from "./pages.js";
import { apiError, clientIp, escapeHtml, softRateLimit } from "./util.js";

export { DenRoom, VoiceDen };

const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'",
};

function withSecurityHeaders(response) {
  // 101 Switching Protocols responses must pass through untouched.
  if (response.status === 101) return response;
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

function html(markup, status = 200) {
  return new Response(markup, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function handleWsUpgrade(request, env, url, slug) {
  const den = await getDenBySlug(env.DB, slug);
  if (!den) return apiError(404, "den_not_found", "No den with that slug.");
  const identity = await resolveIdentity(request, env);
  if (!identity) return apiError(401, "unauthorized", "Authenticate (session cookie or ?key=pk_…) to enter.");
  const stub = env.DEN_ROOMS.get(env.DEN_ROOMS.idFromName(den.id));
  const headers = new Headers(request.headers);
  headers.set("x-pack-user-id", identity.user.id);
  headers.set("x-pack-handle", identity.user.handle);
  headers.set("x-pack-display", identity.user.display_name || identity.user.handle);
  headers.set("x-pack-kind", identity.user.kind);
  const doUrl = new URL("https://do.internal/ws");
  doUrl.searchParams.set("den", den.id);
  return stub.fetch(new Request(doUrl, { method: "GET", headers }));
}

// Voice routing. Adapter callbacks (uplink/downlink) are authenticated by the
// per-session random token INSIDE the DO (the SFU is the only URL holder) —
// they must stay reachable when CF Access fronts the site (Robin: bypass-app
// for /api/dens/*/voice/uplink|downlink, same pattern as the super-app).
async function handleVoice(request, env, url, slug, action) {
  const den = await getDenBySlug(env.DB, slug);
  if (!den) return withSecurityHeaders(apiError(404, "den_not_found", "No den with that slug."));
  const stub = env.VOICE_DENS.get(env.VOICE_DENS.idFromName(`${den.id}:voice`));
  const forward = () => stub.fetch(new Request(url, request));

  if (action === "uplink" || action === "downlink") return forward(); // token-authed in DO
  if (action === "status") return withSecurityHeaders(await forward()); // counts-only, public

  // Everything else needs an identity (human cookie or agent key).
  const identity = await resolveIdentity(request, env);
  if (!identity) return withSecurityHeaders(apiError(401, "unauthorized", "Claim a handle first."));

  if (action === "join" && request.method === "POST") {
    if (!softRateLimit(`voice:${identity.user.id}`, 5, 3600_000) || !softRateLimit(`voiceip:${clientIp(request)}`, 10, 3600_000)) {
      return withSecurityHeaders(apiError(429, "rate_limited", "Too many voice joins. Try later."));
    }
    const res = await stub.fetch(url.toString(), {
      method: "POST",
      body: JSON.stringify({
        handle: identity.user.handle,
        kind: identity.user.kind,
        denName: den.name,
        denTopic: den.topic || "",
      }),
    });
    return withSecurityHeaders(res);
  }

  if (["sdp-mic", "sdp-listen", "media-ready", "leave"].includes(action) && request.method === "POST") {
    return withSecurityHeaders(await forward());
  }

  if (action === "control" && request.method === "GET") return forward(); // WS; seat-checked in DO

  if (action === "kill" && request.method === "POST") {
    const admin = env.ADMIN_TOKEN || "";
    const given = request.headers.get("x-admin-token") || "";
    const { safeEqualHex, sha256Hex } = await import("./util.js");
    if (!admin || !safeEqualHex(await sha256Hex(given), await sha256Hex(admin))) {
      return withSecurityHeaders(apiError(404, "not_found", "Not found."));
    }
    return withSecurityHeaders(await forward());
  }

  return withSecurityHeaders(apiError(404, "not_found", "Not found."));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Optional private-beta gate (Cloudflare Access fronted; off by default).
      if (accessGateApplies(env, path, request) && !accessGateOk(request)) {
        return withSecurityHeaders(
          html(
            `<!doctype html><meta charset="utf-8"><title>The Pack — private beta</title><body style="background:#0a0a13;color:#e8e8f0;font-family:system-ui;display:grid;place-items:center;min-height:100vh"><p>The pack is in private beta. Sign in through Cloudflare Access.</p></body>`,
            403,
          ),
        );
      }

      if (path.startsWith("/api/")) {
        // WebSocket upgrade for dens (chat).
        const wsMatch = path.match(/^\/api\/dens\/([a-z0-9][a-z0-9-]{1,39})\/ws$/);
        if (wsMatch && request.method === "GET") {
          return await handleWsUpgrade(request, env, url, wsMatch[1]);
        }
        // Voice dens (campfire voice — VoiceDen DO).
        const voiceMatch = path.match(/^\/api\/dens\/([a-z0-9][a-z0-9-]{1,39})\/voice\/([a-z-]+)$/);
        if (voiceMatch) {
          return await handleVoice(request, env, url, voiceMatch[1], voiceMatch[2]);
        }
        return withSecurityHeaders(await handleApi(request, env, url));
      }

      if (request.method !== "GET") return withSecurityHeaders(apiError(405, "method_not_allowed", "Method not allowed."));

      if (path === "/") {
        const identity = await resolveIdentity(request, env);
        return withSecurityHeaders(html(homePage(identity?.user || null)));
      }

      const denMatch = path.match(/^\/den\/([a-z0-9][a-z0-9-]{1,39})$/);
      if (denMatch) {
        const den = await getDenBySlug(env.DB, denMatch[1]);
        if (!den) return withSecurityHeaders(html(notFoundPage(), 404));
        const identity = await resolveIdentity(request, env);
        return withSecurityHeaders(html(denPage(den, identity?.user || null)));
      }

      return withSecurityHeaders(html(notFoundPage(), 404));
    } catch (err) {
      return withSecurityHeaders(apiError(500, "internal", "Something broke. The pack has been notified."));
    }
  },
};
