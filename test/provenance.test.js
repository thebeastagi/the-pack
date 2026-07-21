// the-pack — phase 2.7: Agentverse Memory + provenance signing + agent surface.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakeD1, createFakeDoNamespace, createFakeR2, installWebSocketStubs,
} from "./fakes.js";

/** Flush microtasks AND real event-loop turns (crypto.subtle resolves on the
 *  uv threadpool — pure-microtask drains miss it). */
async function drainAsync(turns = 12) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}
import { canonicalJson, publicKeyJwk, signRecord, verifyRecord } from "../src/aevs.js";
import { memoryConfigFromEnv, searchEpisodes, storeEpisode } from "../src/memory.js";
import { buildEpisodeRecord, episodeContent, recordPackEpisode } from "../src/episodes.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);
const jsonHeaders = { "content-type": "application/json" };

async function makeKeypair() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { priv, pub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } };
}

async function makeEnvWithCrypto() {
  const { priv, pub } = await makeKeypair();
  const DB = createFakeD1();
  const env = {
    DB,
    DEN_ROOMS: createFakeDoNamespace({ DB }),
    MEDIA: createFakeR2(),
    ADMIN_TOKEN: "test-admin-token",
    PACK_VERSION: "test",
    PRIVATE_BETA: "0",
    AM_BASE_URL: "https://am.test",
    AM_API_KEY: "am-test-key",
    AM_AGENT_ID: "beast-engineer",
    PACK_SIGNING_KEY_JWK: JSON.stringify(priv),
    PACK_SIGNING_PUB_JWK: JSON.stringify(pub),
    DEN_KEEPER_AGENT_NAME: "the-pack-den-keeper-3",
    DEN_KEEPER_AGENT_ADDRESS: "agent1qtest",
  };
  return { env, pub };
}

/** Capture outbound AM calls by stubbing global fetch. */
function stubFetch(responder) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = responder ? await responder(String(url), init) : { structuredContent: { stored: true, id: "ep-1" } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: body }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

// ── aevs.js unit ────────────────────────────────────────────────────────────

test("canonicalJson sorts keys recursively", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(canonicalJson([{ z: 1, y: 2 }]), '[{"y":2,"z":1}]');
});

test("sign/verify roundtrip + tamper detection", async () => {
  const { priv, pub } = await makeKeypair();
  const env = { PACK_SIGNING_KEY_JWK: JSON.stringify(priv) };
  const record = buildEpisodeRecord("digest", "lobby", "2 member(s), 5 recent message(s)");
  const sig = await signRecord(env, record);
  assert.equal(sig.alg, "ES256");
  assert.equal(sig.kid, "the-pack-v1");
  assert.ok(await verifyRecord(pub, record, sig));
  // tampered record fails
  assert.ok(!(await verifyRecord(pub, { ...record, summary: "forged" }, sig)));
  // no key configured → null, never throws
  assert.equal(await signRecord({}, record), null);
});

test("episodeContent embeds provenance line", () => {
  const record = buildEpisodeRecord("agent_message", "lobby", "den-keeper: hello");
  const withSig = episodeContent(record, { alg: "ES256", kid: "the-pack-v1", sig: "abc" });
  assert.match(withSig, /den:lobby agent_message/);
  assert.match(withSig, /provenance: ES256\/the-pack-v1\/abc/);
  assert.ok(!episodeContent(record, null).includes("provenance"));
});

// ── memory.js unit ──────────────────────────────────────────────────────────

test("memoryConfigFromEnv: null when unconfigured, derives from AM_API_URL", () => {
  assert.equal(memoryConfigFromEnv({}), null);
  const cfg = memoryConfigFromEnv({ AM_API_URL: "https://am.test/mcp", AM_API_KEY: "k" });
  assert.equal(cfg.baseUrl, "https://am.test");
  assert.equal(cfg.agentId, "beast-engineer");
});

test("storeEpisode/searchEpisodes: envelope unwrap + raise-safe failure", async () => {
  const cfg = { baseUrl: "https://am.test", apiKey: "k", agentId: "beast-engineer", timeoutMs: 2000 };
  const okFetch = async () => new Response(JSON.stringify({
    jsonrpc: "2.0", id: 1,
    result: { structuredContent: { stored: true, id: "ep-9" } },
  }));
  const stored = await storeEpisode(cfg, "hello", { fetchImpl: okFetch });
  assert.deepEqual(stored, { available: true, stored: true, id: "ep-9" });

  const searchFetch = async () => new Response(JSON.stringify({
    jsonrpc: "2.0", id: 1,
    result: { structuredContent: { results: [{ episode: { content: "c1", created_at: "t" }, score: 0.9 }] } },
  }));
  const found = await searchEpisodes(cfg, "den:lobby", 5, { fetchImpl: searchFetch });
  assert.equal(found.available, true);
  assert.equal(found.count, 1);
  assert.equal(found.results[0].content, "c1");

  const badFetch = async () => new Response("nope", { status: 500 });
  const failed = await storeEpisode(cfg, "x", { fetchImpl: badFetch });
  assert.equal(failed.available, false);
  assert.match(failed.reason, /http 500/);

  const throwFetch = async () => { throw new Error("socket gone"); };
  const err = await searchEpisodes(cfg, "q", 1, { fetchImpl: throwFetch });
  assert.equal(err.available, false);
});

test("recordPackEpisode: unconfigured memory → honest result, still signs", async () => {
  const { priv } = await makeKeypair();
  const env = { PACK_SIGNING_KEY_JWK: JSON.stringify(priv) };
  const out = await recordPackEpisode(env, null, "voice_session", "lobby", "60s test");
  assert.equal(out.memory, "unconfigured");
  assert.equal(out.signed, true);
  assert.equal(out.record.den, "den:lobby");
});

// ── API surface ─────────────────────────────────────────────────────────────

test("health reports configured features + hosted agent", async () => {
  const { env } = await makeEnvWithCrypto();
  const res = await worker.fetch(req("/api/health"), env);
  const body = await res.json();
  assert.equal(body.features.agentverse_memory, true);
  assert.equal(body.features.provenance_signing, true);
  assert.equal(body.features.hosted_agents[0].address, "agent1qtest");
});

test("/api/aevs/pubkey: 503 unconfigured, public JWK when configured", async () => {
  const DB = createFakeD1();
  const bare = { DB, DEN_ROOMS: createFakeDoNamespace({ DB }), MEDIA: createFakeR2(), PRIVATE_BETA: "0" };
  const res503 = await worker.fetch(req("/api/aevs/pubkey"), bare);
  assert.equal(res503.status, 503);

  const { env, pub } = await makeEnvWithCrypto();
  const res = await worker.fetch(req("/api/aevs/pubkey"), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.alg, "ES256");
  assert.deepEqual(body.jwk, publicKeyJwk(env));
  assert.equal(body.jwk.d, undefined); // never leak private material
  assert.deepEqual({ kty: body.jwk.kty, crv: body.jwk.crv, x: body.jwk.x, y: body.jwk.y }, pub);
});

test("/api/agents lists D1 citizens + hosted Agentverse agent", async () => {
  const { env } = await makeEnvWithCrypto();
  // seed an agent citizen via admin API
  const mk = await worker.fetch(req("/api/admin/agents", {
    method: "POST", headers: { ...jsonHeaders, "x-admin-token": "test-admin-token" },
    body: JSON.stringify({ handle: "den-keeper", displayName: "Den Keeper" }),
  }), env);
  assert.equal(mk.status, 201);
  const res = await worker.fetch(req("/api/agents"), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.citizens[0].handle, "den-keeper");
  assert.equal(body.citizens[0].kind, "agent");
  assert.equal(body.hosted[0].platform, "agentverse");
  assert.equal(body.hosted[0].address, "agent1qtest");
  assert.match(body.hosted[0].source, /agents\/den-keeper\/agent\.py/);
});

test("den memory endpoint: 503 unconfigured; available:false honest on outage; results when up", async () => {
  const DB = createFakeD1();
  const envBare = { DB, DEN_ROOMS: createFakeDoNamespace({ DB }), MEDIA: createFakeR2(), PRIVATE_BETA: "0", ADMIN_TOKEN: "t" };
  // create a den first (need identity)
  const mk = await worker.fetch(req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle: "wolf-a" }) }), envBare);
  const cookie = mk.headers.get("set-cookie")?.split(";")[0] || "";
  await worker.fetch(req("/api/dens", {
    method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug: "pine", name: "Pine" }),
  }), envBare);

  const res503 = await worker.fetch(req("/api/dens/pine/memory"), envBare);
  assert.equal(res503.status, 503);

  const { env } = await makeEnvWithCrypto();
  const mk2 = await worker.fetch(req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle: "wolf-b" }) }), env);
  const cookie2 = mk2.headers.get("set-cookie")?.split(";")[0] || "";
  await worker.fetch(req("/api/dens", {
    method: "POST", headers: { ...jsonHeaders, cookie: cookie2 }, body: JSON.stringify({ slug: "pine", name: "Pine" }),
  }), env);

  const down = stubFetch(async () => { throw new Error("am down"); });
  try {
    const res = await worker.fetch(req("/api/dens/pine/memory"), env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.memory.available, false);
  } finally { down.restore(); }

  const up = stubFetch();
  try {
    const res = await worker.fetch(req("/api/dens/pine/memory?limit=3"), env);
    const body = await res.json();
    assert.equal(body.memory.available, true);
    // query carried the den tag
    const rpc = JSON.parse(up.calls[0].init.body);
    assert.match(rpc.params.arguments.query, /den:pine/);
    assert.equal(rpc.params.arguments.limit, 3);
    assert.equal(up.calls[0].init.headers["x-api-key"], "am-test-key");
  } finally { up.restore(); }
});

test("admin memory-digest: signed record stored + verifiable against pubkey", async () => {
  const { env, pub } = await makeEnvWithCrypto();
  const mk = await worker.fetch(req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle: "wolf-c" }) }), env);
  const cookie = mk.headers.get("set-cookie")?.split(";")[0] || "";
  await worker.fetch(req("/api/dens", {
    method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug: "ember", name: "Ember" }),
  }), env);

  const cap = stubFetch();
  try {
    const res = await worker.fetch(req("/api/admin/memory-digest", {
      method: "POST", headers: { ...jsonHeaders, "x-admin-token": "test-admin-token" },
      body: JSON.stringify({ slug: "ember", note: "phase 2.7 proof" }),
    }), env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.memory, "stored");
    assert.equal(body.signature.alg, "ES256");
    assert.ok(await verifyRecord(pub, body.record, body.signature), "signature must verify against the published pubkey");
    // stored episode content carries the provenance line + den tag
    // (den_created from setup may land in the same capture window — filter)
    const storeBodies = cap.calls.map((c) => JSON.parse(c.init.body)).filter((r) => r.params?.name === "memory_store_episode");
    const rpc = storeBodies.find((r) => r.params.arguments.content.includes("digest"));
    assert.ok(rpc, "expected a digest episode store call");
    assert.equal(rpc.params.name, "memory_store_episode");
    assert.match(rpc.params.arguments.content, /den:ember digest/);
    assert.match(rpc.params.arguments.content, /provenance: ES256\/the-pack-v1\//);
    assert.match(rpc.params.arguments.content, /phase 2\.7 proof/);
    assert.equal(rpc.params.arguments.source, "the-pack");
    // admin auth still required
    const denied = await worker.fetch(req("/api/admin/memory-digest", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ slug: "ember" }),
    }), env);
    assert.equal(denied.status, 404);
  } finally { cap.restore(); }
});

test("private-beta gate: memory recall + pubkey stay reachable (mirror edge bypass apps)", async () => {
  const { env } = await makeEnvWithCrypto();
  env.PRIVATE_BETA = "1";
  const { accessGateApplies } = await import("../src/auth.js");
  const bare = (p) => new Request(`https://pack.test${p}`);
  assert.equal(accessGateApplies(env, "/api/dens/lobby/memory", bare("/api/dens/lobby/memory")), false);
  assert.equal(accessGateApplies(env, "/api/aevs/pubkey", bare("/api/aevs/pubkey")), false);
  assert.equal(accessGateApplies(env, "/api/health", bare("/api/health")), false);
  // humans without Access headers are still gated elsewhere
  assert.equal(accessGateApplies(env, "/api/agents", bare("/api/agents")), true);
  assert.equal(accessGateApplies(env, "/den/lobby", bare("/den/lobby")), true);
});

test("agent message stores a signed episode (fire-and-forget)", async () => {
  const { env } = await makeEnvWithCrypto();
  const mk = await worker.fetch(req("/api/admin/agents", {
    method: "POST", headers: { ...jsonHeaders, "x-admin-token": "test-admin-token" },
    body: JSON.stringify({ handle: "den-keeper" }),
  }), env);
  const { key } = await mk.json();
  await worker.fetch(req("/api/dens/lobby/join", { method: "POST", headers: { authorization: `Bearer ${key}` } }), env)
    .catch(() => {}); // den may not exist; message route creates nothing — seed den first
  // seed lobby via admin seed
  await worker.fetch(req("/api/admin/seed", { method: "POST", headers: { ...jsonHeaders, "x-admin-token": "test-admin-token" } }), env);

  const cap = stubFetch();
  try {
    const res = await worker.fetch(req("/api/dens/lobby/messages", {
      method: "POST", headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
      body: JSON.stringify({ body: "the fire's already lit" }),
    }), env);
    assert.equal(res.status, 201);
    await drainAsync();
    const storeCalls = cap.calls.filter((c) => String(c.url).includes("/mcp"));
    assert.ok(storeCalls.length >= 1, "expected an AM store call for the agent message");
    const rpc = JSON.parse(storeCalls[0].init.body);
    assert.match(rpc.params.arguments.content, /den:lobby agent_message/);
    assert.match(rpc.params.arguments.content, /den-keeper: the fire's already lit/);
  } finally { cap.restore(); }
});
