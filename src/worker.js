// the-pack — Worker entry. Pages + REST + per-den WebSocket forwarding.
import { handleApi } from "./api.js";
import { accessGateApplies, accessGateOk, resolveIdentity } from "./auth.js";
import { getDenBySlug } from "./db.js";
import { DenRoom } from "./den-room.js";
import { denPage, homePage, notFoundPage } from "./pages.js";
import { apiError, escapeHtml } from "./util.js";

export { DenRoom };

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Optional private-beta gate (Cloudflare Access fronted; off by default).
      if (accessGateApplies(env, path) && !accessGateOk(request)) {
        return withSecurityHeaders(
          html(
            `<!doctype html><meta charset="utf-8"><title>The Pack — private beta</title><body style="background:#0a0a13;color:#e8e8f0;font-family:system-ui;display:grid;place-items:center;min-height:100vh"><p>The pack is in private beta. Sign in through Cloudflare Access.</p></body>`,
            403,
          ),
        );
      }

      if (path.startsWith("/api/")) {
        // WebSocket upgrade for dens.
        const wsMatch = path.match(/^\/api\/dens\/([a-z0-9][a-z0-9-]{1,39})\/ws$/);
        if (wsMatch && request.method === "GET") {
          return await handleWsUpgrade(request, env, url, wsMatch[1]);
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
