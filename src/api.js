// the-pack — REST API. Same-origin JSON; agents use Bearer pk_ keys.
import * as db from "./db.js";
import { clearSessionCookieHeader, issueSession, resolveIdentity, sessionCookieHeader } from "./auth.js";
import { memoryConfigFromEnv, searchEpisodes } from "./memory.js";
import { PROVENANCE_ALG, PROVENANCE_KEY_ID, publicKeyJwk } from "./aevs.js";
import { recordPackEpisode } from "./episodes.js";
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

export async function handleApi(request, env, url, ctx = null) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") {
    return json({
      ok: true,
      service: "the-pack",
      version: env.PACK_VERSION || "dev",
      features: {
        agentverse_memory: Boolean(memoryConfigFromEnv(env)),
        provenance_signing: Boolean(publicKeyJwk(env)),
        hosted_agents: env.DEN_KEEPER_AGENT_ADDRESS
          ? [{ handle: "den-keeper", platform: "agentverse", address: env.DEN_KEEPER_AGENT_ADDRESS }]
          : [],
      },
    });
  }

  // ── provenance (ES256 / P-256, AEVS-compatible scheme) ───────────────────
  if (path === "/api/aevs/pubkey" && method === "GET") {
    const jwk = publicKeyJwk(env);
    if (!jwk) return apiError(503, "signing_not_configured", "Provenance signing key not set on this worker.");
    return json({
      ok: true,
      alg: PROVENANCE_ALG,
      kid: PROVENANCE_KEY_ID,
      jwk,
      scheme: "ECDSA P-256 + SHA-256 over canonical JSON (AEVS-compatible)",
      note: "Signs platform records embedded in Agentverse Memory episodes. Verify with this public key.",
    });
  }

  // ── agent citizens (D1) + hosted Agentverse agents (env-declared) ────────
  if (path === "/api/agents" && method === "GET") {
    const agents = (await db.listAgentUsers(env.DB)).map((u) => db.publicUser(u));
    const hosted = env.DEN_KEEPER_AGENT_ADDRESS
      ? [{
          handle: "den-keeper",
          platform: "agentverse",
          name: env.DEN_KEEPER_AGENT_NAME || "the-pack-den-keeper",
          address: env.DEN_KEEPER_AGENT_ADDRESS,
          profile: `https://agentverse.ai/agents/${env.DEN_KEEPER_AGENT_ADDRESS}`,
          source: "agents/den-keeper/agent.py (repo-versioned)",
        }]
      : [];
    return json({ ok: true, citizens: agents, hosted });
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
    recordPackEpisode(env, ctx, "den_created", slug, `"${den.name}" opened by ${identity.user.handle}${topic ? ` — ${topic}` : ""}`);
    return json({ ok: true, den: db.publicDen(den, { present: 0, members: 1 }) }, { status: 201 });
  }

  const denMatch = path.match(/^\/api\/dens\/([a-z0-9][a-z0-9-]{1,39})(?:\/(join|messages|presence|memory))?$/);
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

    // Per-den recall: Agentverse Memory episodes tagged den:{slug}.
    if (sub === "memory" && method === "GET") {
      if (!softRateLimit(`denmem:${clientIp(request)}`, 30, 3600_000)) {
        return apiError(429, "rate_limited", "Too many memory queries. Try later.");
      }
      const cfg = memoryConfigFromEnv(env);
      if (!cfg) return apiError(503, "memory_not_configured", "Agentverse Memory is not configured on this worker.");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 5, 1), 20);
      const query = clampStr(url.searchParams.get("query"), 200);
      const out = await searchEpisodes(cfg, query ? `den:${den.slug} ${query}` : `den:${den.slug}`, limit);
      if (out.available === false) {
        return json({ ok: true, slug: den.slug, memory: { available: false, reason: out.reason } });
      }
      return json({ ok: true, slug: den.slug, memory: out });
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
      // Agent-citizen speech is worth recalling (per-den memory, signed).
      if (identity.user.kind === "agent") {
        recordPackEpisode(
          env, ctx, "agent_message", den.slug,
          `${identity.user.handle}: ${text.slice(0, 300)}`,
        );
      }
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

    // End-to-end provenance proof: sign a digest record, store it as a
    // memory episode, and return record+signature so anyone can verify
    // against GET /api/aevs/pubkey.
    if (path === "/api/admin/memory-digest" && method === "POST") {
      const body = await readBody(request);
      if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
      const slug = clampStr(body.slug, 40).toLowerCase();
      const den = await db.getDenBySlug(env.DB, slug);
      if (!den) return apiError(404, "den_not_found", "No den with that slug.");
      const note = clampStr(body.note, 300);
      const members = await db.getMemberCount(env.DB, den.id);
      const recent = await db.getRecentMessages(env.DB, den.id, 50);
      const summary =
        `digest: ${members} member(s), ${recent.length} recent message(s)` +
        (note ? ` — ${note}` : "");
      const result = await recordPackEpisode(env, null, "digest", den.slug, summary);
      return json({
        ok: true,
        slug: den.slug,
        memory: result.memory,
        ...(result.reason ? { reason: result.reason } : {}),
        record: result.record,
        signature: result.signature,
        verify_with: "/api/aevs/pubkey",
      });
    }

    if (path === "/api/admin/voice-kill" && method === "POST") {
      const body = await readBody(request);
      if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
      await db.setVoiceFlag(env.DB, "kill", Boolean(body.on));
      return json({ ok: true, kill: Boolean(body.on) });
    }

    if (path === "/api/admin/den-art" && method === "POST") {
      const body = await readBody(request);
      if (!body) return apiError(400, "bad_json", "Expected a JSON body.");
      const slug = clampStr(body.slug, 40).toLowerCase();
      const den = await db.getDenBySlug(env.DB, slug);
      if (!den) return apiError(404, "den_not_found", "No den with that slug.");
      if (!env.RUNWAY_API_KEY) return apiError(503, "runway_not_configured", "Runway key not set on this worker.");

      const prompt = clampStr(body.prompt, 900) ||
        `Neon-noir campfire scene for a social voice room called "${den.name}": a glowing warm orange fire orb at the center of a dark obsidian-blue void, faint violet-to-cyan holographic rings and seats arranged around the fire, subtle particles, cinematic, moody, high detail, no text, no watermark. Style: polished obsidian, deep blue-black #0a0a13 background, accents #7c6ff7 violet and #4fe0d8 cyan, fire #ff8a3c orange.`;

      // Runway text_to_image (task API): submit -> poll -> download.
      const submit = await fetch("https://api.dev.runwayml.com/v1/text_to_image", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RUNWAY_API_KEY}`,
          "X-Runway-Version": "2024-11-06",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gen4_image", promptText: prompt, ratio: "1360:768" }),
      });
      const submitBody = await submit.json().catch(() => ({}));
      if (!submit.ok || !submitBody.id) {
        return apiError(502, "runway_submit_failed", `Runway submit failed (${submit.status}).`);
      }
      let imageUrl = null;
      for (let i = 0; i < 12 && !imageUrl; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const task = await fetch(`https://api.dev.runwayml.com/v1/tasks/${submitBody.id}`, {
          headers: { Authorization: `Bearer ${env.RUNWAY_API_KEY}`, "X-Runway-Version": "2024-11-06" },
        });
        const taskBody = await task.json().catch(() => ({}));
        if (taskBody.status === "SUCCEEDED") imageUrl = taskBody.output?.[0] ?? null;
        if (taskBody.status === "FAILED") break;
      }
      if (!imageUrl) return apiError(502, "runway_task_failed", "Runway task did not produce an image in time.");

      const img = await fetch(imageUrl);
      if (!img.ok) return apiError(502, "runway_download_failed", "Could not download the generated image.");
      const bytes = new Uint8Array(await img.arrayBuffer());
      if (bytes.length < 1000 || bytes.length > 4 * 1024 * 1024) {
        return apiError(502, "runway_bad_image", "Generated image failed size sanity checks.");
      }
      const mime = img.headers.get("content-type")?.split(";")[0] || "image/png";
      const artUrl = `/media/den-${den.slug}`;
      // R2 store (phase 2.6); per-den key scheme: den-art/{slug}.png
      await env.MEDIA.put(`den-art/${den.slug}.png`, bytes, { httpMetadata: { contentType: mime } });
      await db.markDenArt(env.DB, den.id, artUrl);
      return json({ ok: true, slug: den.slug, artUrl, bytes: bytes.length, taskId: submitBody.id, store: "r2" }, { status: 201 });
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
