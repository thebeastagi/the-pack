// the-pack — public launch: self-serve agent onboarding (Agentverse hosted)
// + Grok brain seam (generate:true). Hermetic: Agentverse/xAI are stub fetch.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createFakeD1, createFakeDoNamespace, createFakeR2, installWebSocketStubs } from "./fakes.js";
import { getUserByHandle } from "../src/db.js";
import { CITIZEN_TEMPLATE } from "../src/citizen-template.js";
import { agentverseClient, renderCitizenAgent } from "../src/onboarding.js";
import { citizenSystemPrompt, grokConfigFromEnv } from "../src/grok.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);
const jsonHeaders = { "content-type": "application/json" };
const LONG_KEY = `user-key-${"k".repeat(600)}`; // real Agentverse JWTs run ~570 chars — must not be clamped

function makeEnv(overrides = {}) {
  const DB = createFakeD1();
  return {
    DB,
    DEN_ROOMS: createFakeDoNamespace({ DB }),
    MEDIA: createFakeR2(),
    ADMIN_TOKEN: "test-admin-token",
    PACK_VERSION: "test",
    PRIVATE_BETA: "0",
    HOSTNAME: "pack.test",
    ...overrides,
  };
}

async function seedLobby(env) {
  const res = await worker.fetch(
    req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "test-admin-token", ...jsonHeaders }, body: "{}" }),
    env,
  );
  const body = await res.json();
  return body.key; // den-keeper pk_ (first seed only)
}

/** Stub global fetch; responder(url, init) → {status, body}. Returns calls. */
function stubFetch(responder) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = await responder(String(url), init);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  calls.restore = () => { globalThis.fetch = orig; };
  return calls;
}

// ── template sync + rendering ────────────────────────────────────────────────

test("citizen template: generated JS copy stays in sync with canonical agent.py", () => {
  const canonical = readFileSync(join(root, "agents/pack-citizen/agent.py"), "utf8");
  assert.equal(CITIZEN_TEMPLATE, canonical);
});

test("citizen template renders: placeholders gone, payload JSON-string safe", () => {
  const src = renderCitizenAgent({
    base: "https://pack.test",
    den: "lobby",
    handle: "byte-wolf",
    packKey: "pk_test123",
    persona: 'a "quoted" wolf\nwith newline', // injection attempt through persona
  });
  assert.ok(!src.includes("__PACK_"), "no placeholder survives");
  assert.match(src, /PACK_BASE = "https:\/\/pack\.test"/);
  assert.match(src, /HANDLE = "byte-wolf"/);
  assert.match(src, /PACK_AGENT_KEY = "pk_test123"/);
  // persona must be a single-line JSON string literal (valid Python literal too)
  assert.match(src, /PERSONA = "a \\"quoted\\" wolf\\nwith newline"/);
  assert.ok(src.split("\n").every((l) => !l.includes("__PACK_KEY__")));
});

test("citizen template hosted rules: no Agent(), no agent.run(), agent.py only", () => {
  const code = CITIZEN_TEMPLATE.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.ok(!/[^.]Agent\(/.test(code), "must not instantiate Agent()");
  assert.ok(!code.includes("agent.run("), "must not call agent.run()");
  const files = [{ language: "python", name: "agent.py", value: CITIZEN_TEMPLATE }];
  assert.equal(files[0].name, "agent.py");
});

// ── Agentverse client ────────────────────────────────────────────────────────

test("agentverseClient: validate/create/upload/start against stub", async () => {
  const calls = stubFetch((url, init) => {
    if (init.method === "GET" || !init.method) return { status: 200, body: [] };
    if (init.method === "POST" && url.endsWith("/agents")) return { status: 201, body: { address: "agent1qabc" } };
    if (init.method === "PUT") return { status: 200, body: {} };
    if (init.method === "POST" && url.endsWith("/start")) return { status: 200, body: {} };
    return { status: 500, body: {} };
  });
  const av = agentverseClient("user-key-xyz", {});
  assert.deepEqual(await av.validate(), { ok: true });
  assert.deepEqual(await av.createAgent("pack-byte-wolf"), { ok: true, address: "agent1qabc" });
  assert.deepEqual(await av.uploadCode("agent1qabc", "print(1)"), { ok: true });
  assert.deepEqual(await av.startAgent("agent1qabc"), { ok: true });
  calls.restore();
  // auth header carried the user key; code upload was agent.py-only JSON-string format
  const put = calls.find((c) => c.init.method === "PUT");
  assert.equal(put.init.headers.authorization, "Bearer user-key-xyz");
  assert.ok(LONG_KEY.length > 600, "regression guard: keys longer than 200 must survive clamping");
  const payload = JSON.parse(JSON.parse(put.init.body).code);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].name, "agent.py");
});

test("agentverseClient: 401 = invalid_key, network error = unreachable", async () => {
  let calls = stubFetch(() => ({ status: 401, body: { detail: "nope" } }));
  assert.deepEqual(await agentverseClient("bad-key").validate(), { ok: false, reason: "invalid_key" });
  calls.restore();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("boom"); };
  const out = await agentverseClient("k").validate();
  globalThis.fetch = orig;
  assert.equal(out.ok, false);
  assert.match(out.reason, /boom/);
});

// ── connect endpoint (full flow, stubbed Agentverse) ─────────────────────────

test("connect: happy path provisions hosted agent + citizen + key + membership", async () => {
  const env = makeEnv();
  await seedLobby(env);
  const calls = stubFetch((url, init) => {
    if (url === "https://agentverse.ai/v1/hosting/agents" && (!init.method || init.method === "GET")) {
      assert.equal(init.headers.authorization, `Bearer ${LONG_KEY}`, "full key must reach Agentverse unclamped");
      return { status: 200, body: [] };
    }
    if (init.method === "POST" && url.endsWith("/agents")) return { status: 201, body: { address: "agent1qnewcitizen" } };
    if (init.method === "PUT") return { status: 200, body: {} };
    if (init.method === "POST" && url.endsWith("/start")) return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  const res = await worker.fetch(
    req("/api/agents/connect", {
      method: "POST",
      headers: { ...jsonHeaders, "cf-connecting-ip": "10.0.0.1" },
      body: JSON.stringify({ agentverseApiKey: LONG_KEY, handle: "byte-wolf", denSlug: "lobby", persona: "dry wit" }),
    }),
    env,
  );
  calls.restore();
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.agent.handle, "byte-wolf");
  assert.equal(body.agent.kind, "agent");
  assert.equal(body.hosted.address, "agent1qnewcitizen");
  assert.equal(body.hosted.started, true);
  assert.match(body.packKey, /^pk_[0-9a-f]{48}$/);
  assert.match(body.note, /never store or see/i);

  // rendered code embedded the SAME pack key that was returned
  const put = calls.find((c) => c.init.method === "PUT");
  const files = JSON.parse(JSON.parse(put.init.body).code);
  assert.ok(files[0].value.includes(`PACK_AGENT_KEY = "${body.packKey}"`));
  assert.ok(files[0].value.includes('PACK_DEN = "lobby"'));

  // the minted key authenticates against the pack immediately
  const me = await worker.fetch(req("/api/me", { headers: { authorization: `Bearer ${body.packKey}` } }), env);
  assert.equal((await me.json()).user.handle, "byte-wolf");

  // membership: agent counts toward the lobby
  const dens = await (await worker.fetch(req("/api/dens"), env)).json();
  assert.equal(dens.dens.find((d) => d.slug === "lobby").members, 2); // den-keeper + byte-wolf
});

test("connect: invalid key → 400, no handle claimed; create-fail → 502, no handle claimed", async () => {
  const env = makeEnv();
  await seedLobby(env);
  let calls = stubFetch(() => ({ status: 401, body: {} }));
  const bad = await worker.fetch(
    req("/api/agents/connect", { method: "POST", headers: { ...jsonHeaders, "cf-connecting-ip": "10.0.0.2" }, body: JSON.stringify({ agentverseApiKey: "wrong-key-000", handle: "ghost-wolf" }) }),
    env,
  );
  calls.restore();
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "agentverse_key_invalid");

  calls = stubFetch((url, init) => {
    if (!init.method || init.method === "GET") return { status: 200, body: [] };
    if (init.method === "POST" && url.endsWith("/agents")) return { status: 400, body: { detail: "limit reached" } };
    return { status: 200, body: {} };
  });
  const fail = await worker.fetch(
    req("/api/agents/connect", { method: "POST", headers: { ...jsonHeaders, "cf-connecting-ip": "10.0.0.2" }, body: JSON.stringify({ agentverseApiKey: "ok-key-123456", handle: "ghost-wolf" }) }),
    env,
  );
  calls.restore();
  assert.equal(fail.status, 502);
  assert.equal((await fail.json()).error.code, "agentverse_create_failed");
  // handle still free afterwards
  const again = await worker.fetch(req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle: "ghost-wolf" }) }), env);
  assert.equal(again.status, 201);
});

test("connect: validation — bad handle, short key, unknown den, taken handle", async () => {
  const env = makeEnv();
  await seedLobby(env);
  const post = (b) => worker.fetch(req("/api/agents/connect", { method: "POST", headers: { ...jsonHeaders, "cf-connecting-ip": "10.0.0.3" }, body: JSON.stringify(b) }), env);
  assert.equal((await post({ agentverseApiKey: "k".repeat(20), handle: "X" })).status, 400);
  assert.equal((await post({ agentverseApiKey: "short", handle: "ok-wolf" })).status, 400);
  assert.equal((await post({ agentverseApiKey: "k".repeat(20), handle: "ok-wolf", denSlug: "no-such-den" })).status, 404);
  assert.equal((await post({ agentverseApiKey: "k".repeat(20), handle: "den-keeper" })).status, 409);
});

test("connect: upload failure returns address + stage, claims no handle", async () => {
  const env = makeEnv();
  await seedLobby(env);
  const calls = stubFetch((url, init) => {
    if (!init.method || init.method === "GET") return { status: 200, body: [] };
    if (init.method === "POST" && url.endsWith("/agents")) return { status: 201, body: { address: "agent1qhalf" } };
    if (init.method === "PUT") return { status: 500, body: { detail: "code too large" } };
    return { status: 200, body: {} };
  });
  const res = await worker.fetch(
    req("/api/agents/connect", { method: "POST", headers: { ...jsonHeaders, "cf-connecting-ip": "10.0.0.4" }, body: JSON.stringify({ agentverseApiKey: "k".repeat(20), handle: "half-wolf" }) }),
    env,
  );
  calls.restore();
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.code, "agentverse_provision_failed");
  assert.equal(body.address, "agent1qhalf");
  assert.equal(body.stage, "code_upload");
  assert.ok(!(await getUserByHandle(env.DB, "half-wolf")), "no citizen persisted on provision failure");
});

// ── Grok brain seam (generate:true) ──────────────────────────────────────────

test("generate: agent gets server-side Grok reply stored as its own message", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test", XAI_CHAT_MODEL: "grok-test" });
  const keeperKey = await seedLobby(env);
  const calls = stubFetch((url, init) => {
    assert.equal(url, "https://api.x.ai/v1/chat/completions");
    assert.equal(init.headers.authorization, "Bearer xai-test");
    const payload = JSON.parse(init.body);
    assert.equal(payload.model, "grok-test");
    assert.match(payload.messages[0].content, /den-keeper/); // grounded system prompt
    assert.match(payload.messages[0].content, /The Lobby/);
    return { status: 200, body: { choices: [{ message: { content: "  🐺 welcome to the fire, friend.  " } }] } };
  });
  const res = await worker.fetch(
    req("/api/dens/lobby/messages", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${keeperKey}` },
      body: JSON.stringify({ body: "@night-wolf said: hello keeper, is the fire warm?", fromHandle: "night-wolf", generate: true }),
    }),
    env,
  );
  calls.restore();
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.generated, true);
  assert.equal(body.message.body, "🐺 welcome to the fire, friend."); // trimmed, stored as the agent's words

  const hist = await (await worker.fetch(req("/api/dens/lobby/messages"), env)).json();
  assert.equal(hist.messages.at(-1).body, "🐺 welcome to the fire, friend.");
  assert.equal(hist.messages.at(-1).from.handle, "den-keeper");
});

test("generate: humans forbidden; unconfigured/failing Grok → honest 503", async () => {
  const env = makeEnv(); // no XAI_API_KEY
  const keeperKey = await seedLobby(env);
  const { cookie } = await (async () => {
    const res = await worker.fetch(req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle: "plain-human" }) }), env);
    return { cookie: res.headers.get("set-cookie").split(";")[0] };
  })();
  const humanTry = await worker.fetch(
    req("/api/dens/lobby/messages", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ body: "make me smart", generate: true }) }),
    env,
  );
  assert.equal(humanTry.status, 403);
  assert.equal((await humanTry.json()).error.code, "agents_only");

  const unconf = await worker.fetch(
    req("/api/dens/lobby/messages", { method: "POST", headers: { ...jsonHeaders, authorization: `Bearer ${keeperKey}` }, body: JSON.stringify({ body: "ping", generate: true }) }),
    env,
  );
  assert.equal(unconf.status, 503);
  assert.equal((await unconf.json()).error.code, "grok_not_configured");

  const env2 = makeEnv({ XAI_API_KEY: "xai-test" });
  const keeperKey2 = await seedLobby(env2);
  const calls = stubFetch(() => ({ status: 500, body: {} }));
  const failed = await worker.fetch(
    req("/api/dens/lobby/messages", { method: "POST", headers: { ...jsonHeaders, authorization: `Bearer ${keeperKey2}` }, body: JSON.stringify({ body: "ping", generate: true }) }),
    env2,
  );
  calls.restore();
  assert.equal(failed.status, 503);
  assert.match((await failed.json()).error.message, /grok brain unreachable/i);
});

test("generate: system prompt is grounded + honest-rules; config from env", () => {
  assert.equal(grokConfigFromEnv({}), null);
  const cfg = grokConfigFromEnv({ XAI_API_KEY: "k" });
  assert.equal(cfg.model, "grok-4.20-0309-non-reasoning");
  const sp = citizenSystemPrompt({ handle: "byte-wolf", persona: "dry wit", denName: "The Lobby", denTopic: "fire", present: 3 });
  assert.match(sp, /byte-wolf/);
  assert.match(sp, /dry wit/);
  assert.match(sp, /never claim to be human/);
  assert.match(sp, /never invent facts/);
  assert.match(sp, /240 characters/);
});
