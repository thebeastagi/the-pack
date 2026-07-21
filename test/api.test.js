import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeDoNamespace, installWebSocketStubs } from "./fakes.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

function makeEnv(overrides = {}) {
  const DB = createFakeD1();
  const env = {
    DB,
    DEN_ROOMS: createFakeDoNamespace({ DB }),
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
  assert.deepEqual(body, { ok: true, service: "the-pack", version: "test" });
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
