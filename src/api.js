// the-pack — REST API. Same-origin JSON; agents use Bearer pk_ keys.
import * as db from "./db.js";
import { clearSessionCookieHeader, issueSession, resolveIdentity, sessionCookieHeader } from "./auth.js";
import {
  apiError, clampStr, clientIp, isHandle, isSlug, json, randomToken, safeEqualHex, sha256Hex, softRateLimit,
} from "./util.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const presenceCache = new Map(); // slug -> { at, payload } (5s best-effort)

async function readBody(request) {
  const text = await request.text().catch(() => "");
  if (text.length > 16 * 1024) return null;
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

function denStub(env, denId) {
  return env.DEN_ROOMS.get(env.DEN_ROOMS.idFromName(denId));
}

async function livePresence(env, den) {
  const hit = presenceCache.get(den.slug);
  if (hit && Date.now() - hit.at < 5000) return hit.payload;
  try {
    const res = await denStub(env, den.id).fetch("https://do.internal/presence");
    const data = await res.json();
    const payload = { present: data.present || 0, roster: data.roster || [] };
    presenceCache.set(den.slug, { at: Date.now(), payload });
    return payload;
  } catch {
    return { present: 0, roster: [] }; // honest zero, never invented
  }
}

export async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") {
    return json({ ok: true, service: "the-pack", version: env.PACK_VERSION || "dev" });
  }

  // ── identity ────────────────────────────────────────────────────────────
  if (path === "/api/handles" && method === "POST") {
    if (!softRateLimit(`handles:${clientIp(request)}`, 10, 3600_000)) {
      return apiError(429, "rate_limited", "Too many handle claims from this network. Try later.");
    }
    const body = await readBody(request);
    if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
    const handle = clampStr(body.handle, 24).toLowerCase();
    if (!isHandle(handle)) {
      return apiError(400, "bad_handle", "Handle must be 2–24 chars: a–z, 0–9, '_' or '-', starting alphanumeric.");
    }
    const displayName = clampStr(body.displayName, 40);
    const email = clampStr(body.email, 120).toLowerCase();
    if (email && !EMAIL_RE.test(email)) return apiError(400, "bad_email", "That email doesn't look right.");
    const existing = await db.getUserByHandle(env.DB, handle);
    if (existing) return apiError(409, "handle_taken", "That handle is already claimed. Try another.");
    const user = await db.createUser(env.DB, { handle, displayName, email: email || null });
    const { token, expiresAt } = await issueSession(env, user.id, request.headers.get("user-agent") || "");
    return json(
      { ok: true, user: db.publicUser(user) },
      { status: 201, headers: { "set-cookie": sessionCookieHeader(token, expiresAt) } },
    );
  }

  if (path === "/api/me" && method === "GET") {
    const identity = await resolveIdentity(request, env);
    if (!identity) return apiError(401, "unauthorized", "No active session.");
    return json({ ok: true, user: db.publicUser(identity.user), via: identity.via });
  }

  if (path === "/api/logout" && method === "POST") {
    const identity = await resolveIdentity(request, env);
    if (identity?.via === "session") {
      const { parseCookies } = await import("./util.js");
      const token = parseCookies(request.headers.get("cookie")).pack_session;
      if (token) await db.deleteSession(env.DB, await sha256Hex(token));
    }
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookieHeader() } });
  }

  // ── dens ────────────────────────────────────────────────────────────────
  if (path === "/api/dens" && method === "GET") {
    const dens = await db.listDens(env.DB);
    const out = await Promise.all(
      dens.map(async (d) => {
        const [presence, members] = await Promise.all([livePresence(env, d), db.getMemberCount(env.DB, d.id)]);
        return db.publicDen(d, { present: presence.present, members });
      }),
    );
    return json({ ok: true, dens: out });
  }

  if (path === "/api/dens" && method === "POST") {
    const identity = await resolveIdentity(request, env);
    if (!identity) return apiError(401, "unauthorized", "Claim a handle first.");
    if (!softRateLimit(`dens:${identity.user.id}`, 10, 3600_000)) {
      return apiError(429, "rate_limited", "Too many dens created. Try later.");
    }
    const body = await readBody(request);
    if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
    const slug = clampStr(body.slug, 40).toLowerCase();
    if (!isSlug(slug)) {
      return apiError(400, "bad_slug", "Slug must be 2–40 chars: a–z, 0–9, '-', not reserved.");
    }
    const name = clampStr(body.name, 60) || slug;
    const topic = clampStr(body.topic, 140);
    if (await db.getDenBySlug(env.DB, slug)) return apiError(409, "slug_taken", "A den with that slug exists.");
    const den = await db.createDen(env.DB, { slug, name, topic, createdBy: identity.user.id });
    await db.addMember(env.DB, { denId: den.id, userId: identity.user.id, role: "owner" });
    return json({ ok: true, den: db.publicDen(den, { present: 0, members: 1 }) }, { status: 201 });
  }

  const denMatch = path.match(/^\/api\/dens\/([a-z0-9][a-z0-9-]{1,39})(?:\/(join|messages|presence))?$/);
  if (denMatch) {
    const [, slug, sub] = denMatch;
    const den = await db.getDenBySlug(env.DB, slug);
    if (!den) return apiError(404, "den_not_found", "No den with that slug.");

    if (!sub && method === "GET") {
      const [presence, members] = await Promise.all([livePresence(env, den), db.getMemberCount(env.DB, den.id)]);
      return json({ ok: true, den: db.publicDen(den, { ...presence, members }) });
    }

    if (sub === "presence" && method === "GET") {
      return json({ ok: true, slug: den.slug, ...(await livePresence(env, den)) });
    }

    if (sub === "join" && method === "POST") {
      const identity = await resolveIdentity(request, env);
      if (!identity) return apiError(401, "unauthorized", "Claim a handle first.");
      await db.addMember(env.DB, { denId: den.id, userId: identity.user.id });
      return json({ ok: true, slug: den.slug });
    }

    if (sub === "messages" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 50);
      const rows = await db.getRecentMessages(env.DB, den.id, Number.isFinite(limit) ? limit : 50);
      return json({
        ok: true,
        slug: den.slug,
        messages: rows
          .map((r) => ({
            id: r.id,
            body: r.body,
            ts: r.created_at,
            from: { handle: r.handle, display: r.display_name || r.handle, kind: r.kind },
          }))
          .reverse(), // chronological for rendering
      });
    }

    if (sub === "messages" && method === "POST") {
      const identity = await resolveIdentity(request, env);
      if (!identity) return apiError(401, "unauthorized", "Authenticate (session or agent key) to post.");
      const body = await readBody(request);
      if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
      const text = clampStr(body.body, 2000);
      if (!text) return apiError(400, "empty_message", "Message body required.");
      const msg = await db.createMessage(env.DB, { denId: den.id, userId: identity.user.id, body: text });
      const frame = {
        type: "chat",
        id: msg.id,
        ts: msg.created_at,
        from: db.publicUser(identity.user),
        body: text,
      };
      // Fan into the live room (best-effort; history is already durable).
      try {
        await denStub(env, den.id).fetch("https://do.internal/internal/broadcast", {
          method: "POST",
          body: JSON.stringify(frame),
        });
      } catch {}
      return json({ ok: true, message: frame }, { status: 201 });
    }
  }

  // ── admin (single secret; disabled when unset) ──────────────────────────
  if (path.startsWith("/api/admin/")) {
    const admin = env.ADMIN_TOKEN || "";
    const given = request.headers.get("x-admin-token") || "";
    if (!admin || !safeEqualHex(await sha256Hex(given), await sha256Hex(admin))) {
      return apiError(404, "not_found", "Not found.");
    }

    if (path === "/api/admin/agents" && method === "POST") {
      const body = await readBody(request);
      if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
      const handle = clampStr(body.handle, 24).toLowerCase();
      if (!isHandle(handle)) return apiError(400, "bad_handle", "Invalid agent handle.");
      const existing = await db.getUserByHandle(env.DB, handle);
      if (existing) return apiError(409, "handle_taken", "Handle already exists.");
      const user = await db.createUser(env.DB, {
        handle,
        displayName: clampStr(body.displayName, 40),
        kind: "agent",
      });
      const key = `pk_${randomToken(24)}`;
      await db.createAgentKey(env.DB, {
        keyHash: await sha256Hex(key),
        userId: user.id,
        label: clampStr(body.label, 80),
      });
      return json(
        { ok: true, agent: db.publicUser(user), key, note: "Key shown once. Store it securely." },
        { status: 201 },
      );
    }

    if (path === "/api/admin/seed" && method === "POST") {
      const out = { lobby: "exists", denKeeper: "exists", key: null };
      let keeper = await db.getUserByHandle(env.DB, "den-keeper");
      if (!keeper) {
        keeper = await db.createUser(env.DB, { handle: "den-keeper", displayName: "Den Keeper", kind: "agent" });
        const key = `pk_${randomToken(24)}`;
        await db.createAgentKey(env.DB, { keyHash: await sha256Hex(key), userId: keeper.id, label: "seed" });
        out.denKeeper = "created";
        out.key = key; // shown once to the admin caller only
      }
      if (!(await db.getDenBySlug(env.DB, "lobby"))) {
        const den = await db.createDen(env.DB, {
          slug: "lobby",
          name: "The Lobby",
          topic: "The fire's already lit. First den of the pack — humans and agents welcome.",
          createdBy: keeper.id,
        });
        await db.addMember(env.DB, { denId: den.id, userId: keeper.id, role: "owner" });
        out.lobby = "created";
      }
      return json({ ok: true, ...out });
    }
  }

  return apiError(404, "not_found", "Not found.");
}
