// the-pack — Grok brain upgrades (2026-07-21): live-aware den brains
// (web_search + x_search), brain tiers, /imagine, spend caps. Hermetic: xAI is
// a stubbed fetch; D1 is the SQL-dispatching fake.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeDoNamespace, createFakeR2, installWebSocketStubs } from "./fakes.js";
import { SQL } from "../src/db.js";
import { todayKey } from "../src/caps.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);
const jsonHeaders = { "content-type": "application/json" };
const PNG = new Uint8Array(2048).fill(7);
const PNG_B64 = Buffer.from(PNG).toString("base64");

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
  return (await res.json()).key; // den-keeper pk_
}

async function claimHuman(env, handle) {
  const res = await worker.fetch(
    req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle }) }),
    env,
  );
  return res.headers.get("set-cookie").split(";")[0];
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
  calls.xai = () => calls.filter((c) => c.url.startsWith("https://api.x.ai/"));
  return calls;
}

const postGenerate = (env, slug, key, marker = "what is the latest?") =>
  worker.fetch(
    req(`/api/dens/${slug}/messages`, {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
      body: JSON.stringify({ body: marker, generate: true }),
    }),
    env,
  );

const responsesOk = (text, { web = 1, x = 1, ticks = 250000000 } = {}) => ({
  status: 200,
  body: {
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { server_side_tool_usage_details: { web_search_calls: web, x_search_calls: x }, cost_in_usd_ticks: ticks },
  },
});

const usageRow = (env, den, kind) =>
  env.DB._tables.brain_usage.find((r) => r.day === todayKey() && r.den === den && r.kind === kind);

// ── den creation: brain config ───────────────────────────────────────────────

test("den creation: brain tier + search toggle persist; invalid tier rejected", async () => {
  const env = makeEnv();
  const cookie = await claimHuman(env, "den-maker");

  const bad = await worker.fetch(
    req("/api/dens", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug: "bad-brain", brainTier: "ultra" }) }),
    env,
  );
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "bad_brain_tier");

  const mk = await worker.fetch(
    req("/api/dens", {
      method: "POST",
      headers: { ...jsonHeaders, cookie },
      body: JSON.stringify({ slug: "deep-den", name: "Deep Den", brainTier: "premium", searchTools: false }),
    }),
    env,
  );
  assert.equal(mk.status, 201);
  const { den } = await mk.json();
  assert.equal(den.brainTier, "premium");
  assert.equal(den.searchTools, false);

  const listed = await (await worker.fetch(req("/api/dens"), env)).json();
  const row = listed.dens.find((d) => d.slug === "deep-den");
  assert.equal(row.brainTier, "premium");
  assert.equal(row.searchTools, false);

  // defaults: standard tier, search ON
  const mk2 = await worker.fetch(
    req("/api/dens", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug: "plain-den" }) }),
    env,
  );
  const den2 = (await mk2.json()).den;
  assert.equal(den2.brainTier, "standard");
  assert.equal(den2.searchTools, true);
});

// ── live-aware generate seam ─────────────────────────────────────────────────

test("generate (live-search den): Responses API tools path + usage ledger per den and global", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test", XAI_CHAT_MODEL: "grok-test" });
  const key = await seedLobby(env);
  const calls = stubFetch((url, init) => {
    assert.equal(url, "https://api.x.ai/v1/responses");
    assert.equal(init.headers.authorization, "Bearer xai-test");
    const payload = JSON.parse(init.body);
    assert.equal(payload.model, "grok-test");
    assert.deepEqual(payload.tools, [{ type: "web_search" }, { type: "x_search" }]);
    assert.equal(payload.max_turns, 3);
    assert.equal(payload.store, false);
    assert.equal(payload.prompt_cache_key, "pack-den-lobby");
    assert.match(payload.instructions, /live web and X search/);
    return responsesOk("fresh from the wire 🐺", { web: 2, x: 1 });
  });
  const res = await postGenerate(env, "lobby", key);
  calls.restore();
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.generated, true);
  assert.equal(body.message.body, "fresh from the wire 🐺");
  assert.deepEqual(body.brain, { tier: "standard", model: "grok-test", search: "used" });

  // exact xAI cost logged per den AND under the global sentinel
  assert.deepEqual(usageRow(env, "lobby", "search"), { day: todayKey(), den: "lobby", kind: "search", calls: 3, ticks: 250000000 });
  assert.deepEqual(usageRow(env, "*", "search"), { day: todayKey(), den: "*", kind: "search", calls: 3, ticks: 250000000 });
});

test("generate: Responses rejected → chat-completions live-search fallback", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test" });
  const key = await seedLobby(env);
  const calls = stubFetch((url, init) => {
    if (url === "https://api.x.ai/v1/responses") return { status: 400, body: { error: "model lacks tools" } };
    if (url === "https://api.x.ai/v1/chat/completions") {
      const payload = JSON.parse(init.body);
      assert.equal(payload.search_parameters.mode, "auto");
      assert.deepEqual(payload.search_parameters.sources, [{ type: "web" }, { type: "x" }]);
      return {
        status: 200,
        body: {
          choices: [{ message: { content: "fallback live answer" } }],
          usage: { num_sources_used: 2, cost_in_usd_ticks: 120000000 },
        },
      };
    }
    return { status: 404, body: {} };
  });
  const res = await postGenerate(env, "lobby", key);
  calls.restore();
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.message.body, "fallback live answer");
  assert.equal(body.brain.search, "used");
  assert.equal(usageRow(env, "lobby", "search").calls, 2);
  assert.equal(usageRow(env, "lobby", "search").ticks, 120000000);
});

test("generate: den search cap → tools-off completion (no paid call), brain.search=capped", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test", PACK_SEARCH_DEN_CAP: "1" });
  const key = await seedLobby(env);
  const calls = stubFetch((url, init) => {
    if (url === "https://api.x.ai/v1/responses") return responsesOk("first live answer", { web: 1, x: 0, ticks: 50000000 });
    if (url === "https://api.x.ai/v1/chat/completions") {
      const payload = JSON.parse(init.body);
      assert.ok(!payload.tools, "no tools on the plain path");
      assert.ok(!payload.search_parameters, "no live search on the plain path");
      return { status: 200, body: { choices: [{ message: { content: "plain reply" } }], usage: { cost_in_usd_ticks: 5000000 } } };
    }
    return { status: 404, body: {} };
  });
  const first = await postGenerate(env, "lobby", key);
  assert.equal((await first.json()).brain.search, "used");
  const second = await postGenerate(env, "lobby", key, "second question");
  calls.restore();
  const body = await second.json();
  assert.equal(body.brain.search, "capped");
  assert.equal(body.message.body, "plain reply");
  // exactly ONE Responses call happened (cap stopped the second)
  assert.equal(calls.xai().filter((c) => c.url.includes("/responses")).length, 1);
  // plain-path tokens are ledgered too (kind=chat, calls=0)
  assert.equal(usageRow(env, "lobby", "chat").ticks, 5000000);
});

test("generate: daily USD ceiling → fail closed before the paid call", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test", PACK_BRAIN_DAILY_USD_CAP: "0.01" }); // 1e8 ticks
  const key = await seedLobby(env);
  const calls = stubFetch((url) => {
    if (url === "https://api.x.ai/v1/responses") return responsesOk("spendy answer", { ticks: 250000000 }); // 2.5e8 > cap
    if (url === "https://api.x.ai/v1/chat/completions") {
      return { status: 200, body: { choices: [{ message: { content: "plain again" } }] } };
    }
    return { status: 404, body: {} };
  });
  const first = await postGenerate(env, "lobby", key);
  assert.equal((await first.json()).brain.search, "used"); // under cap at check time
  const second = await postGenerate(env, "lobby", key, "again");
  calls.restore();
  assert.equal((await second.json()).brain.search, "capped");
  assert.equal(calls.xai().filter((c) => c.url.includes("/responses")).length, 1, "ceiling stopped the second paid call");
});

test("generate: usage ledger unreadable → fail CLOSED (plain completion, no paid call)", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test" });
  const realPrepare = env.DB.prepare;
  env.DB.prepare = (sql) => {
    if (sql === SQL.brainUsageGet) throw new Error("d1 down");
    return realPrepare(sql);
  };
  const key = await seedLobby(env);
  const calls = stubFetch((url) => {
    if (url === "https://api.x.ai/v1/chat/completions") {
      return { status: 200, body: { choices: [{ message: { content: "safe plain reply" } }] } };
    }
    return { status: 500, body: {} };
  });
  const res = await postGenerate(env, "lobby", key);
  calls.restore();
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.brain.search, "closed");
  assert.equal(body.message.body, "safe plain reply");
  assert.equal(calls.xai().filter((c) => c.url.includes("/responses")).length, 0, "no paid call when the ledger is down");
});

test("generate: brain tiers — premium=grok-4.5, build=grok-build-0.1 (env-overridable)", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test", PACK_SEARCH_DEFAULT: "0", XAI_PREMIUM_MODEL: "grok-4.5-test" });
  const key = await seedLobby(env);
  const cookie = await claimHuman(env, "tier-maker");
  for (const [slug, tier] of [["prem-den", "premium"], ["build-den", "build"]]) {
    await worker.fetch(
      req("/api/dens", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug, brainTier: tier }) }),
      env,
    );
  }
  const seen = [];
  const calls = stubFetch((url, init) => {
    if (url === "https://api.x.ai/v1/chat/completions") {
      seen.push(JSON.parse(init.body).model);
      return { status: 200, body: { choices: [{ message: { content: "tier reply" } }] } };
    }
    return { status: 500, body: {} };
  });
  await postGenerate(env, "prem-den", key);
  await postGenerate(env, "build-den", key);
  calls.restore();
  assert.deepEqual(seen, ["grok-4.5-test", "grok-build-0.1"]);
});

// ── /imagine ─────────────────────────────────────────────────────────────────

test("/imagine: paints via xAI → R2 → media route; usage logged per den + global", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test", XAI_IMAGE_MODEL: "imagine-test" });
  const cookie = await claimHuman(env, "art-wolf");
  await seedLobby(env);
  const calls = stubFetch((url, init) => {
    assert.equal(url, "https://api.x.ai/v1/images/generations");
    const payload = JSON.parse(init.body);
    assert.equal(payload.model, "imagine-test");
    assert.equal(payload.response_format, "b64_json");
    assert.equal(payload.n, 1);
    assert.match(payload.prompt, /neon wolf/);
    return { status: 200, body: { data: [{ b64_json: PNG_B64, mime_type: "image/png" }], usage: { cost_in_usd_ticks: 20000000 } } };
  });
  const res = await worker.fetch(
    req("/api/dens/lobby/messages", {
      method: "POST",
      headers: { ...jsonHeaders, cookie },
      body: JSON.stringify({ body: "/imagine a neon wolf howling at a cyan moon" }),
    }),
    env,
  );
  calls.restore();
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.imagined, true);
  const m = body.message.body.match(/^\/imagine a neon wolf howling at a cyan moon\n🎨 (\/media\/gen\/(lobby-[0-9a-f]{16})\.png)$/);
  assert.ok(m, `message body carries the media ref: ${body.message.body}`);

  // bytes landed in R2 and the media route serves them
  assert.ok(env.MEDIA._store.has(`gen/${m[2]}.png`));
  const media = await worker.fetch(req(m[1]), env);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "image/png");
  const served = new Uint8Array(await media.arrayBuffer());
  assert.equal(served.length, PNG.length);

  // history replays the same body (chat render paints it client-side)
  const hist = await (await worker.fetch(req("/api/dens/lobby/messages"), env)).json();
  assert.equal(hist.messages.at(-1).body, body.message.body);

  assert.deepEqual(usageRow(env, "lobby", "image"), { day: todayKey(), den: "lobby", kind: "image", calls: 1, ticks: 20000000 });
  assert.equal(usageRow(env, "*", "image").calls, 1);
});

test("/imagine: empty prompt 400; xAI failure → honest 503, nothing stored or charged", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test" });
  const cookie = await claimHuman(env, "art-wolf-2");
  await seedLobby(env);

  const empty = await worker.fetch(
    req("/api/dens/lobby/messages", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ body: "/imagine" }) }),
    env,
  );
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, "imagine_empty");

  const calls = stubFetch(() => ({ status: 500, body: {} }));
  const failed = await worker.fetch(
    req("/api/dens/lobby/messages", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ body: "/imagine a void" }) }),
    env,
  );
  calls.restore();
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error.code, "imagine_unavailable");
  assert.equal(env.MEDIA._store.size, 0, "no R2 write on failure");
  assert.equal(env.DB._tables.brain_usage.length, 0, "no charge logged on failure");
});

test("/imagine: den cap → 429 imagine_capped, no xAI call, no charge", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test", PACK_IMAGE_DEN_CAP: "1" });
  const cookie = await claimHuman(env, "art-wolf-3");
  await seedLobby(env);
  const calls = stubFetch((url) => {
    if (url === "https://api.x.ai/v1/images/generations") {
      return { status: 200, body: { data: [{ b64_json: PNG_B64, mime_type: "image/png" }], usage: { cost_in_usd_ticks: 20000000 } } };
    }
    return { status: 404, body: {} };
  });
  const post = () =>
    worker.fetch(
      req("/api/dens/lobby/messages", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ body: "/imagine another wolf" }) }),
      env,
    );
  const first = await post();
  assert.equal(first.status, 201);
  const second = await post();
  calls.restore();
  assert.equal(second.status, 429);
  const err = (await second.json()).error;
  assert.equal(err.code, "imagine_capped");
  assert.match(err.message, /Nothing was charged/);
  assert.equal(calls.xai().length, 1, "cap stopped the second paid call");
});

// ── admin ledger readout ─────────────────────────────────────────────────────

test("admin brain-usage: 404-cloaked without token; ledger + caps + USD with token", async () => {
  const env = makeEnv({ XAI_API_KEY: "xai-test" });
  const noTok = await worker.fetch(req("/api/admin/brain-usage"), env);
  assert.equal(noTok.status, 404);

  const cookie = await claimHuman(env, "art-wolf-4");
  await seedLobby(env);
  const calls = stubFetch(() => ({
    status: 200,
    body: { data: [{ b64_json: PNG_B64, mime_type: "image/png" }], usage: { cost_in_usd_ticks: 20000000 } },
  }));
  await worker.fetch(
    req("/api/dens/lobby/messages", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ body: "/imagine ledger test" }) }),
    env,
  );
  calls.restore();

  const res = await worker.fetch(req("/api/admin/brain-usage", { headers: { "x-admin-token": "test-admin-token" } }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.day, todayKey());
  assert.equal(body.rows.length, 2); // den row + '*' rollup
  assert.equal(body.globalTicks, 20000000);
  assert.equal(body.globalUsd, 0.002);
  assert.equal(body.caps.imageDen, 15);
  assert.equal(body.caps.searchGlobal, 600);
});

// ── pages ────────────────────────────────────────────────────────────────────

test("pages: creation form exposes brain controls; den page shows brain + /imagine hint", async () => {
  const env = makeEnv();
  const cookie = await claimHuman(env, "page-wolf");
  const home = await (await worker.fetch(req("/", { headers: { cookie } }), env)).text();
  assert.match(home, /name="brainTier"/);
  assert.match(home, /Grok 4\.5 — premium/);
  assert.match(home, /live web \+ X search for den brains/);

  await worker.fetch(
    req("/api/dens", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug: "prem-view", brainTier: "premium" }) }),
    env,
  );
  const page = await (await worker.fetch(req("/den/prem-view", { headers: { cookie } }), env)).text();
  assert.match(page, /🧠 Grok 4\.5/);
  assert.match(page, /live web \+ X search \(capped\)/);
  assert.match(page, /\/imagine/);
});
