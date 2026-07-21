import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeDoNamespace, createFakeR2, installWebSocketStubs } from "./fakes.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

function makeEnv(overrides = {}) {
  const DB = createFakeD1();
  const env = {
    DB,
    DEN_ROOMS: createFakeDoNamespace({ DB }),
    MEDIA: createFakeR2(),
    ADMIN_TOKEN: "test-admin-token",
    PACK_VERSION: "test",
    PRIVATE_BETA: "0",
    ...overrides,
  };
  return env;
}

const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);
const jsonHeaders = { "content-type": "application/json" };

async function claimHandle(env, handle, extra = {}) {
  const res = await worker.fetch(req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle, ...extra }) }), env);
  const cookie = res.headers.get("set-cookie")?.split(";")[0] || "";
  return { res, cookie, body: await res.json() };
}

test("health", async () => {
  const env = makeEnv();
  const res = await worker.fetch(req("/api/health"), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, {
    ok: true,
    service: "the-pack",
    version: "test",
    features: {
      agentverse_memory: false,
      provenance_signing: false,
      grok_brain: false,
      live_search: false,
      imagine: false,
      brain_tiers: ["standard", "premium", "build"],
      self_serve_agents: true,
      hosted_agents: [],
    },
  });
});

test("home page renders with brand + security headers", async () => {
  const env = makeEnv();
  const res = await worker.fetch(req("/"), env);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /The Pack/);
  assert.match(html, /--obsidian-1:#0a0a13/);
  assert.match(html, /presence rings are receipts/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
});

test("handle claim: validation, session cookie, uniqueness, me", async () => {
  const env = makeEnv();

  const bad = await worker.fetch(req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle: "X" }) }), env);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "bad_handle");

  const { res, cookie, body } = await claimHandle(env, "night-wolf", { displayName: "Night Wolf", email: "w@den.net" });
  assert.equal(res.status, 201);
  assert.equal(body.user.handle, "night-wolf");
  assert.equal(body.user.kind, "human");
  assert.match(cookie, /^pack_session=[0-9a-f]{64}$/);
  assert.match(res.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);

  const dup = await claimHandle(env, "NIGHT-WOLF"); // case-insensitive unique
  assert.equal(dup.res.status, 409);

  const me = await worker.fetch(req("/api/me", { headers: { cookie } }), env);
  assert.equal((await me.json()).user.display, "Night Wolf");

  const anon = await worker.fetch(req("/api/me"), env);
  assert.equal(anon.status, 401);
});

test("den lifecycle: create → list → join → REST chat → history", async () => {
  const env = makeEnv();
  const { cookie } = await claimHandle(env, "alpha-human");

  const unauth = await worker.fetch(req("/api/dens", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ slug: "wolves" }) }), env);
  assert.equal(unauth.status, 401);

  const created = await worker.fetch(
    req("/api/dens", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug: "wolves", name: "Wolves", topic: "test den" }) }),
    env,
  );
  assert.equal(created.status, 201);
  assert.equal((await created.json()).den.slug, "wolves");

  const dupe = await worker.fetch(req("/api/dens", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug: "wolves" }) }), env);
  assert.equal(dupe.status, 409);

  const list = await (await worker.fetch(req("/api/dens"), env)).json();
  assert.equal(list.dens.length, 1);
  assert.equal(list.dens[0].present, 0); // honest zero — nobody connected
  assert.equal(list.dens[0].members, 1);

  const second = await claimHandle(env, "beta-human");
  const join = await worker.fetch(req("/api/dens/wolves/join", { method: "POST", headers: { cookie: second.cookie } }), env);
  assert.equal(join.status, 200);
  const detail = await (await worker.fetch(req("/api/dens/wolves"), env)).json();
  assert.equal(detail.den.members, 2);

  const posted = await worker.fetch(
    req("/api/dens/wolves/messages", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ body: "first howl" }) }),
    env,
  );
  assert.equal(posted.status, 201);
  const frame = (await posted.json()).message;
  assert.equal(frame.from.handle, "alpha-human");
  assert.equal(frame.body, "first howl");

  const hist = await (await worker.fetch(req("/api/dens/wolves/messages"), env)).json();
  assert.equal(hist.messages.length, 1);
  assert.equal(hist.messages[0].body, "first howl");

  const pres = await (await worker.fetch(req("/api/dens/wolves/presence"), env)).json();
  assert.deepEqual(pres.roster, []);

  const missing = await worker.fetch(req("/api/dens/nope"), env);
  assert.equal(missing.status, 404);
});

test("den page renders with honest empty-den state", async () => {
  const env = makeEnv();
  const { cookie } = await claimHandle(env, "stage-tester");
  await worker.fetch(req("/api/dens", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug: "stage", name: "Stage Den" }) }), env);
  const res = await worker.fetch(req("/den/stage", { headers: { cookie } }), env);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Stage Den/);
  assert.match(html, /den-stage empty/);
  assert.match(html, /the fire burns low — the pack is elsewhere/);
  assert.match(html, /new WebSocket/);
  const missing = await worker.fetch(req("/den/nope"), env);
  assert.equal(missing.status, 404);
});

test("admin: disabled without token, agents + seed with token; agent key flow", async () => {
  const env = makeEnv();
  const noTok = await worker.fetch(req("/api/admin/agents", { method: "POST", headers: jsonHeaders, body: "{}" }), env);
  assert.equal(noTok.status, 404);
  const badTok = await worker.fetch(req("/api/admin/agents", { method: "POST", headers: { ...jsonHeaders, "x-admin-token": "wrong" }, body: "{}" }), env);
  assert.equal(badTok.status, 404);

  const created = await worker.fetch(
    req("/api/admin/agents", { method: "POST", headers: { ...jsonHeaders, "x-admin-token": "test-admin-token" }, body: JSON.stringify({ handle: "scout-1", displayName: "Scout" }) }),
    env,
  );
  assert.equal(created.status, 201);
  const agentBody = await created.json();
  assert.equal(agentBody.agent.kind, "agent");
  assert.match(agentBody.key, /^pk_[0-9a-f]{48}$/);

  const me = await worker.fetch(req("/api/me", { headers: { authorization: `Bearer ${agentBody.key}` } }), env);
  assert.equal((await me.json()).via, "agent-key");

  const envNoAdmin = makeEnv({ ADMIN_TOKEN: "" });
  const disabled = await worker.fetch(req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "x" } }), envNoAdmin);
  assert.equal(disabled.status, 404);

  const seed1 = await (await worker.fetch(req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "test-admin-token" } }), env)).json();
  assert.equal(seed1.lobby, "created");
  assert.equal(seed1.denKeeper, "created");
  assert.match(seed1.key, /^pk_/);
  const seed2 = await (await worker.fetch(req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "test-admin-token" } }), env)).json();
  assert.deepEqual({ lobby: seed2.lobby, denKeeper: seed2.denKeeper, key: seed2.key }, { lobby: "exists", denKeeper: "exists", key: null });
});

test("agent posts to a den via REST with Bearer key", async () => {
  const env = makeEnv();
  const seed = await (await worker.fetch(req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "test-admin-token" } }), env)).json();
  const posted = await worker.fetch(
    req("/api/dens/lobby/messages", { method: "POST", headers: { ...jsonHeaders, authorization: `Bearer ${seed.key}` }, body: JSON.stringify({ body: "den-keeper online" }) }),
    env,
  );
  assert.equal(posted.status, 201);
  const frame = (await posted.json()).message;
  assert.equal(frame.from.kind, "agent");
  assert.equal(frame.from.handle, "den-keeper");
});

test("private beta gate (CF Access) when PRIVATE_BETA=1", async () => {
  const env = makeEnv({ PRIVATE_BETA: "1" });
  const blocked = await worker.fetch(req("/"), env);
  assert.equal(blocked.status, 403);
  const healthOk = await worker.fetch(req("/api/health"), env);
  assert.equal(healthOk.status, 200);
  const allowed = await worker.fetch(req("/", { headers: { "cf-access-authenticated-user-email": "judge@x.ai" } }), env);
  assert.equal(allowed.status, 200);
  // Access service tokens (CI) carry the JWT assertion instead of an email header
  const svc = await worker.fetch(req("/", { headers: { "cf-access-jwt-assertion": "edge-issued-jwt" } }), env);
  assert.equal(svc.status, 200);
});

test("WS upgrade: auth required, then 101 + welcome with roster", async () => {
  const env = makeEnv();
  await worker.fetch(req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "test-admin-token" } }), env);

  const unauth = await worker.fetch(req("/api/dens/lobby/ws", { headers: { upgrade: "websocket" } }), env);
  assert.equal(unauth.status, 401);

  const missing = await worker.fetch(req("/api/dens/nope/ws", { headers: { upgrade: "websocket" } }), env);
  assert.equal(missing.status, 404);
  const { cookie } = await claimHandle(env, "ws-wolf");
  const res = await worker.fetch(req("/api/dens/lobby/ws", { headers: { upgrade: "websocket", cookie } }), env);
  assert.equal(res.status, 101);
  const frames = res.webSocket.received.map((f) => JSON.parse(f));
  const welcome = frames.find((f) => f.type === "welcome");
  assert.ok(welcome, "welcome frame delivered");
  assert.equal(welcome.you.handle, "ws-wolf");
  assert.equal(welcome.present, 1);
  const join = frames.find((f) => f.type === "presence");
  assert.equal(join.action, "join");
});

test("private beta gate: agent-key API calls exempt, humans need Access", async () => {
  const env = makeEnv({ PRIVATE_BETA: "1" });
  const seed = await (await worker.fetch(req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "test-admin-token", "cf-access-authenticated-user-email": "admin@test" } }), env)).json();
  // agent with Bearer pk_ passes without Access headers
  const agentMe = await worker.fetch(req("/api/me", { headers: { authorization: `Bearer ${seed.key}` } }), env);
  assert.equal(agentMe.status, 200);
  // agent WS-style ?key= passes too
  const agentWs = await worker.fetch(req(`/api/dens/lobby/ws?key=${seed.key}`, { headers: { upgrade: "websocket" } }), env);
  assert.equal(agentWs.status, 101);
  // human API call without Access header is blocked
  const humanApi = await worker.fetch(req("/api/dens"), env);
  assert.equal(humanApi.status, 403);
});

test("private beta gate: edge-bypass paths stay reachable (own auth layers)", async () => {
  // Minimal VoiceDen stand-in: answers like the DO's token check. The point of
  // this test is that the beta gate must NOT intercept before the DO routing.
  const voiceCalls = [];
  const VOICE_DENS = {
    idFromName: (n) => n,
    get: () => ({
      fetch: async (r) => {
        voiceCalls.push(new URL(typeof r === "string" ? r : r.url).pathname);
        return new Response("forbidden", { status: 403 });
      },
    }),
  };
  const env = makeEnv({ PRIVATE_BETA: "1", VOICE_DENS });
  await worker.fetch(req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "test-admin-token", "cf-access-authenticated-user-email": "admin@test" } }), env);

  // SFU adapter callbacks: gate must NOT intercept — the DO's per-session
  // token check answers (403 without token), never the beta-gate 403 page.
  for (const action of ["uplink", "downlink"]) {
    const res = await worker.fetch(req(`/api/dens/lobby/voice/${action}?token=wrong`), env);
    assert.equal(res.status, 403);
    assert.equal(await res.text(), "forbidden", `${action}: DO token check answered, not the gate`);
  }
  assert.equal(voiceCalls.length, 2, "both callbacks reached the VoiceDen stub");

  // Den reads used by agent citizens through the edge bypass (public pre-flip).
  const msgs = await worker.fetch(req("/api/dens/lobby/messages?limit=5"), env);
  assert.equal(msgs.status, 200);
  const pres = await worker.fetch(req("/api/dens/lobby/presence"), env);
  assert.equal(pres.status, 200);

  // POST messages through the bypass still demands a real identity.
  const anonPost = await worker.fetch(
    req("/api/dens/lobby/messages", { method: "POST", body: JSON.stringify({ body: "hi" }) }),
    env,
  );
  assert.equal(anonPost.status, 401);

  // Emergency kill switch stays reachable; ADMIN_TOKEN still enforced (404-cloaked).
  const badKill = await worker.fetch(req("/api/admin/voice-kill", { method: "POST", headers: { "x-admin-token": "nope" } }), env);
  assert.equal(badKill.status, 404);

  // Health exempt as before.
  const health = await worker.fetch(req("/api/health"), env);
  assert.equal(health.status, 200);
});

test("den art: R2 serving with marker; 404 when object absent", async () => {
  const env = makeEnv();
  await worker.fetch(req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "test-admin-token" } }), env);
  const bytes = new Uint8Array(2048).fill(9);
  const missing = await worker.fetch(req("/media/den-lobby"), env);
  assert.equal(missing.status, 404);
  await env.MEDIA.put("den-art/lobby.png", bytes, { httpMetadata: { contentType: "image/png" } });
  const r2 = await worker.fetch(req("/media/den-lobby"), env);
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get("x-pack-art-source"), "r2");
  assert.equal(r2.headers.get("content-type"), "image/png");
  const served = new Uint8Array(await r2.arrayBuffer());
  assert.equal(served.length, bytes.length);
});

test("den art: admin generate (fake Runway) → media route serves bytes → page shows banner", async () => {
  const png = new Uint8Array(2048).fill(7); // >1KB sanity floor
  const calls = [];
  const runwayFetch = async (input, init) => {
    calls.push(String(input));
    if (String(input).includes("text_to_image")) {
      return new Response(JSON.stringify({ id: "task-1" }), { status: 200 });
    }
    if (String(input).includes("/tasks/task-1")) {
      return new Response(JSON.stringify({ status: "SUCCEEDED", output: ["https://img.test/art.png"] }), { status: 200 });
    }
    if (String(input) === "https://img.test/art.png") {
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    }
    return worker.fetch(new Request(String(input), init), env);
  };
  const env = makeEnv({ RUNWAY_API_KEY: "rk-test" });
  env._fetch = runwayFetch; // (worker uses global fetch; patch below)
  const realFetch = globalThis.fetch;
  globalThis.fetch = runwayFetch;
  try {
    await worker.fetch(req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "test-admin-token" } }), env);
    const gen = await worker.fetch(
      req("/api/admin/den-art", { method: "POST", headers: { ...jsonHeaders, "x-admin-token": "test-admin-token" }, body: JSON.stringify({ slug: "lobby" }) }),
      env,
    );
    assert.equal(gen.status, 201);
    const genBody = await gen.json();
    assert.equal(genBody.artUrl, "/media/den-lobby");
    assert.equal(genBody.store, "r2");
    assert.ok(env.MEDIA._store.has("den-art/lobby.png"), "art bytes in R2");
    assert.ok(calls.some((c) => c.includes("text_to_image")));

    const media = await worker.fetch(req("/media/den-lobby"), env);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("content-type"), "image/png");
    const served = new Uint8Array(await media.arrayBuffer());
    assert.equal(served.length, png.length);

    const page = await worker.fetch(req("/den/lobby"), env);
    const html = await page.text();
    assert.match(html, /den-art/);
    assert.match(html, /\/media\/den-lobby/);

    const missing = await worker.fetch(req("/media/den-nope"), env);
    assert.equal(missing.status, 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});
