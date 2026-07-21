// the-pack — wave 2 (2026-07-21): Collections RAG. Per-den xAI knowledge
// bases (docs endpoints), brain file_search integration with citations,
// 'rag' spend kind under the SAME fail-closed caps. Hermetic: xAI is a
// stubbed fetch; D1 is the SQL-dispatching fake.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeD1, createFakeDoNamespace, createFakeR2, installWebSocketStubs } from "./fakes.js";
import { SQL } from "../src/db.js";
import { todayKey, voiceAllowed, voiceSecondsToTicks } from "../src/caps.js";
import { docStatusFromXai } from "../src/collections.js";

installWebSocketStubs();
const { default: worker } = await import("../src/worker.js");

const req = (path, init = {}) => new Request(`https://pack.test${path}`, init);
const jsonHeaders = { "content-type": "application/json" };

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
    XAI_API_KEY: "test-xai-key",
    ...overrides,
  };
}

async function seedLobby(env) {
  const res = await worker.fetch(
    req("/api/admin/seed", { method: "POST", headers: { "x-admin-token": "test-admin-token", ...jsonHeaders }, body: "{}" }),
    env,
  );
  return (await res.json()).key;
}

async function claimHuman(env, handle) {
  const res = await worker.fetch(
    req("/api/handles", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ handle }) }),
    env,
  );
  return res.headers.get("set-cookie").split(";")[0];
}

async function makeDen(env, cookie, slug) {
  const res = await worker.fetch(
    req("/api/dens", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ slug, name: slug }) }),
    env,
  );
  assert.equal(res.status, 201);
  return (await res.json()).den;
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

/** xAI collections management responder (create → upload → add → list). */
function mgmtResponder(state = {}) {
  state.collectionId = state.collectionId || "collection_test-1";
  state.fileId = state.fileId || "file_test-1";
  state.docs = state.docs || [];
  return (url, init) => {
    if (url === "https://api.x.ai/v1/collections" && init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.ok(body.collection_name, "collection_name sent");
      assert.ok(Array.isArray(body.field_definitions), "field_definitions sent");
      return { status: 200, body: { collection_id: state.collectionId } };
    }
    if (url === "https://api.x.ai/v1/files" && init.method === "POST") {
      assert.ok(init.body instanceof FormData, "file upload is multipart FormData");
      return { status: 200, body: { id: state.fileId } };
    }
    if (url === `https://api.x.ai/v1/collections/${state.collectionId}/documents/${state.fileId}` && init.method === "POST") {
      return { status: 200, body: {} };
    }
    if (url === `https://api.x.ai/v1/collections/${state.collectionId}/documents` && (!init.method || init.method === "GET")) {
      return { status: 200, body: { documents: state.docs } };
    }
    if (url.includes("/documents/") && init.method === "DELETE") return { status: 200, body: {} };
    return { status: 404, body: { error: `unstubbed ${init.method || "GET"} ${url}` } };
  };
}

const usageRow = (env, den, kind) =>
  env.DB._tables.brain_usage.find((r) => r.day === todayKey() && r.den === den && r.kind === kind);

// ── collections client + doc status mapping ─────────────────────────────────

test("docStatusFromXai: chunk counters are the truth (live-observed lag)", () => {
  assert.equal(docStatusFromXai(null), "processing");
  assert.equal(docStatusFromXai({ error_message: "boom", chunk_count: 1, chunks_processed_count: 1 }), "failed");
  assert.equal(docStatusFromXai({ chunk_count: 1, chunks_processed_count: 1, error_message: null }), "ready");
  assert.equal(docStatusFromXai({ chunk_count: 3, chunks_processed_count: 1, error_message: null }), "processing");
  assert.equal(docStatusFromXai({ chunk_count: 0, chunks_processed_count: 0, error_message: null }), "processing");
});

// ── docs endpoints ──────────────────────────────────────────────────────────

test("docs POST: auth required; validation; happy path creates collection lazily + doc row", async () => {
  const env = makeEnv();
  const calls = stubFetch(mgmtResponder());
  try {
    const cookie = await claimHuman(env, "kb-owner");
    await makeDen(env, cookie, "kb-den");

    const anon = await worker.fetch(
      req("/api/dens/kb-den/docs", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "Lore", content: "x".repeat(40) }) }),
      env,
    );
    assert.equal(anon.status, 401);

    const short = await worker.fetch(
      req("/api/dens/kb-den/docs", { method: "POST", headers: { ...jsonHeaders, cookie }, body: JSON.stringify({ name: "Lore", content: "tiny" }) }),
      env,
    );
    assert.equal(short.status, 400);

    const ok = await worker.fetch(
      req("/api/dens/kb-den/docs", {
        method: "POST",
        headers: { ...jsonHeaders, cookie },
        body: JSON.stringify({ name: "Den Lore", content: "The fire was lit on the first night of the pack." }),
      }),
      env,
    );
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.equal(body.doc.name, "Den Lore");
    assert.equal(body.doc.status, "processing");

    const seq = calls.xai().map((c) => `${c.init.method || "GET"} ${c.url.replace("https://api.x.ai/v1/", "")}`);
    assert.deepEqual(seq, [
      "POST collections",
      "POST files",
      "POST collections/collection_test-1/documents/file_test-1",
    ]);
    assert.equal(env.DB._tables.den_collections.length, 1);
    assert.equal(env.DB._tables.den_docs.length, 1);

    // Second doc reuses the collection (no second create).
    const ok2 = await worker.fetch(
      req("/api/dens/kb-den/docs", {
        method: "POST",
        headers: { ...jsonHeaders, cookie },
        body: JSON.stringify({ name: "More Lore", content: "The second night the wolves sang until dawn." }),
      }),
      env,
    );
    assert.equal(ok2.status, 201);
    assert.equal(calls.xai().filter((c) => c.url === "https://api.x.ai/v1/collections").length, 1);
  } finally {
    calls.restore();
  }
});

test("docs GET: lists docs; lazy status sync processing→ready from xAI chunk counters", async () => {
  const env = makeEnv();
  const state = {};
  const calls = stubFetch(mgmtResponder(state));
  try {
    const cookie = await claimHuman(env, "kb-owner");
    await makeDen(env, cookie, "kb-den");
    await worker.fetch(
      req("/api/dens/kb-den/docs", {
        method: "POST",
        headers: { ...jsonHeaders, cookie },
        body: JSON.stringify({ name: "Lore", content: "The fire was lit on the first night of the pack." }),
      }),
      env,
    );
    // xAI now reports the doc fully chunked → GET flips the row to ready.
    state.docs = [{ file_metadata: { file_id: "file_test-1" }, chunk_count: 2, chunks_processed_count: 2, error_message: null }];
    const list = await (await worker.fetch(req("/api/dens/kb-den/docs"), env)).json();
    assert.equal(list.ok, true);
    assert.equal(list.knowledgeBase, true);
    assert.equal(list.docs.length, 1);
    assert.equal(list.docs[0].status, "ready");
    assert.equal(env.DB._tables.den_docs[0].status, "ready");
  } finally {
    calls.restore();
  }
});

test("docs GET: xAI sync failure never breaks the listing (honest processing)", async () => {
  const env = makeEnv();
  const base = mgmtResponder();
  const calls = stubFetch((url, init) => {
    if (url.includes("/documents") && (!init.method || init.method === "GET")) return { status: 500, body: { error: "down" } };
    return base(url, init);
  });
  try {
    const cookie = await claimHuman(env, "kb-owner");
    await makeDen(env, cookie, "kb-den");
    await worker.fetch(
      req("/api/dens/kb-den/docs", {
        method: "POST",
        headers: { ...jsonHeaders, cookie },
        body: JSON.stringify({ name: "Lore", content: "The fire was lit on the first night of the pack." }),
      }),
      env,
    );
    const res = await worker.fetch(req("/api/dens/kb-den/docs"), env);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.docs[0].status, "processing");
  } finally {
    calls.restore();
  }
});

test("docs DELETE: adder or admin only; xAI removal called; row deleted", async () => {
  const env = makeEnv();
  const calls = stubFetch(mgmtResponder());
  try {
    const cookie = await claimHuman(env, "kb-owner");
    const other = await claimHuman(env, "kb-other");
    await makeDen(env, cookie, "kb-den");
    const created = await (await worker.fetch(
      req("/api/dens/kb-den/docs", {
        method: "POST",
        headers: { ...jsonHeaders, cookie },
        body: JSON.stringify({ name: "Lore", content: "The fire was lit on the first night of the pack." }),
      }),
      env,
    )).json();

    const denied = await worker.fetch(
      req(`/api/dens/kb-den/docs/${created.doc.id}`, { method: "DELETE", headers: { cookie: other } }),
      env,
    );
    assert.equal(denied.status, 403);

    const del = await worker.fetch(
      req(`/api/dens/kb-den/docs/${created.doc.id}`, { method: "DELETE", headers: { cookie } }),
      env,
    );
    assert.equal(del.status, 200);
    assert.equal(env.DB._tables.den_docs.length, 0);
    assert.ok(calls.xai().some((c) => c.init.method === "DELETE" && c.url.includes("/documents/file_test-1")));
  } finally {
    calls.restore();
  }
});

test("docs POST: den doc cap refuses honestly (no xAI call)", async () => {
  const env = makeEnv({ PACK_DEN_DOCS_CAP: "1" });
  const calls = stubFetch(mgmtResponder());
  try {
    const cookie = await claimHuman(env, "kb-owner");
    await makeDen(env, cookie, "kb-den");
    await worker.fetch(
      req("/api/dens/kb-den/docs", {
        method: "POST",
        headers: { ...jsonHeaders, cookie },
        body: JSON.stringify({ name: "One", content: "The fire was lit on the first night of the pack." }),
      }),
      env,
    );
    const second = await worker.fetch(
      req("/api/dens/kb-den/docs", {
        method: "POST",
        headers: { ...jsonHeaders, cookie },
        body: JSON.stringify({ name: "Two", content: "The second night the wolves sang until dawn." }),
      }),
      env,
    );
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.code, "docs_cap");
    assert.equal(calls.xai().filter((c) => c.url === "https://api.x.ai/v1/files").length, 1, "no second upload");
  } finally {
    calls.restore();
  }
});

// ── brain RAG path ───────────────────────────────────────────────────────────

/** Seed a den with a collection + one ready doc directly in the fake tables. */
function seedKnowledge(env, denId, { fileId = "file_test-1", name = "Den Lore" } = {}) {
  env.DB._tables.den_collections.push({ den_id: denId, collection_id: "collection_test-1", created_at: "2026-07-21" });
  env.DB._tables.den_docs.push({
    id: "doc-1", den_id: denId, file_id: fileId, name, bytes: 100,
    status: "ready", added_by: "seed", created_at: "2026-07-21",
  });
}

const denIdBySlug = (env, slug) => env.DB._tables.dens.find((d) => d.slug === slug).id;

const ragResponsesOk = (text, { rag = 1, web = 0, x = 0, ticks = 48556500, cite = true } = {}) => ({
  status: 200,
  body: {
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text,
            annotations: cite
              ? [{ type: "url_citation", url: "collections://collection_test-1/files/file_test-1", title: "Den Lore" }]
              : [],
          },
        ],
      },
    ],
    usage: {
      server_side_tool_usage_details: { web_search_calls: web, x_search_calls: x, file_search_calls: rag },
      cost_in_usd_ticks: ticks,
    },
  },
});

test("generate: den with knowledge base → file_search tool + citation line + brain.rag=used", async () => {
  const env = makeEnv();
  const calls = stubFetch((url) => {
    if (url === "https://api.x.ai/v1/responses") return ragResponsesOk("The fire was lit on the first night, says our lore.");
    return { status: 404, body: { error: `unstubbed ${url}` } };
  });
  try {
    const key = await seedLobby(env);
    const cookie = await claimHuman(env, "kb-owner");
    await makeDen(env, cookie, "kb-den");
    seedKnowledge(env, denIdBySlug(env, "kb-den"));

    const res = await worker.fetch(
      req("/api/dens/kb-den/messages", {
        method: "POST",
        headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
        body: JSON.stringify({ body: "when was the fire lit?", generate: true }),
      }),
      env,
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.generated, true);
    assert.equal(body.brain.rag, "used");
    assert.match(body.message.body, /first night/);
    assert.match(body.message.body, /📚 Den Lore/, "citation line appended with doc name");

    // The Responses call carried file_search (den collection) AND live tools.
    const rc = calls.xai().find((c) => c.url === "https://api.x.ai/v1/responses");
    const sent = JSON.parse(rc.init.body);
    const types = sent.tools.map((t) => t.type);
    assert.deepEqual(types, ["file_search", "web_search", "x_search"]);
    assert.deepEqual(sent.tools[0].vector_store_ids, ["collection_test-1"]);
    assert.equal(sent.store, false);

    // Ledger: rag row carries the full ticks; no search row (0 web/x calls).
    const ragRow = usageRow(env, "kb-den", "rag");
    assert.equal(ragRow.calls, 1);
    assert.equal(ragRow.ticks, 48556500);
    assert.equal(usageRow(env, "kb-den", "search"), undefined);
    // Global rollup rows exist for the USD ceiling.
    assert.equal(usageRow(env, "*", "rag").ticks, 48556500);
  } finally {
    calls.restore();
  }
});

test("generate: rag capped → live-search-only path (no file_search tool), rag=capped", async () => {
  const env = makeEnv({ PACK_RAG_DEN_CAP: "1" });
  const calls = stubFetch((url) => {
    if (url === "https://api.x.ai/v1/responses") {
      return ragResponsesOk(" searched the live fire ", { rag: 0, web: 1, x: 0, cite: false });
    }
    return { status: 404, body: { error: `unstubbed ${url}` } };
  });
  try {
    const key = await seedLobby(env);
    const cookie = await claimHuman(env, "kb-owner");
    await makeDen(env, cookie, "kb-den");
    seedKnowledge(env, denIdBySlug(env, "kb-den"));
    // Burn the den's rag budget (1 call) before the real request.
    env.DB._tables.brain_usage.push({ day: todayKey(), den: "kb-den", kind: "rag", calls: 1, ticks: 100 });

    const res = await worker.fetch(
      req("/api/dens/kb-den/messages", {
        method: "POST",
        headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
        body: JSON.stringify({ body: "when was the fire lit?", generate: true }),
      }),
      env,
    );
    const body = await res.json();
    assert.equal(body.brain.rag, "capped");
    assert.equal(body.brain.search, "used");
    const rc = calls.xai().find((c) => c.url === "https://api.x.ai/v1/responses");
    const types = JSON.parse(rc.init.body).tools.map((t) => t.type);
    assert.deepEqual(types, ["web_search", "x_search"], "no file_search when rag is capped");
  } finally {
    calls.restore();
  }
});

test("generate: rag ledger read error → rag=closed, no paid rag call (fail closed)", async () => {
  const env = makeEnv();
  const origPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql === SQL.brainUsageGet) return { bind: () => ({ first: async () => { throw new Error("d1 down"); } }) };
    return origPrepare(sql);
  };
  const calls = stubFetch((url) => {
    if (url === "https://api.x.ai/v1/chat/completions") {
      return { status: 200, body: { choices: [{ message: { content: "plain fallback" } }], usage: { cost_in_usd_ticks: 5 } } };
    }
    return { status: 404, body: { error: `unstubbed ${url}` } };
  });
  try {
    const key = await seedLobby(env);
    const cookie = await claimHuman(env, "kb-owner");
    await makeDen(env, cookie, "kb-den");
    seedKnowledge(env, denIdBySlug(env, "kb-den"));

    const res = await worker.fetch(
      req("/api/dens/kb-den/messages", {
        method: "POST",
        headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
        body: JSON.stringify({ body: "when was the fire lit?", generate: true }),
      }),
      env,
    );
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.brain.rag, "closed");
    assert.equal(body.brain.search, "closed"); // same ledger, same fail-closed read
    assert.equal(calls.xai().filter((c) => c.url === "https://api.x.ai/v1/responses").length, 0, "no Responses call");
    assert.equal(usageRow(env, "kb-den", "rag"), undefined, "no rag spend logged");
  } finally {
    calls.restore();
  }
});

test("generate: Responses rejection on RAG path → rag=unavailable via live-search fallback", async () => {
  const env = makeEnv();
  const calls = stubFetch((url) => {
    if (url === "https://api.x.ai/v1/responses") return { status: 400, body: { error: "model rejects responses" } };
    if (url === "https://api.x.ai/v1/chat/completions") {
      return {
        status: 200,
        body: { choices: [{ message: { content: "live fallback answer" } }], usage: { num_sources_used: 1, cost_in_usd_ticks: 1000 } },
      };
    }
    return { status: 404, body: { error: `unstubbed ${url}` } };
  });
  try {
    const key = await seedLobby(env);
    const cookie = await claimHuman(env, "kb-owner");
    await makeDen(env, cookie, "kb-den");
    seedKnowledge(env, denIdBySlug(env, "kb-den"));

    const res = await worker.fetch(
      req("/api/dens/kb-den/messages", {
        method: "POST",
        headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
        body: JSON.stringify({ body: "when was the fire lit?", generate: true }),
      }),
      env,
    );
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.brain.rag, "unavailable");
    assert.equal(body.brain.search, "used");
    const ragRow = usageRow(env, "kb-den", "rag");
    assert.equal(ragRow.calls, 0, "no rag calls on the fallback path");
    assert.equal(ragRow.ticks, 1000, "fallback ticks still ledgered under rag (single bill)");
  } finally {
    calls.restore();
  }
});

test("generate: no knowledge base → classic search path, NO rag key (regression)", async () => {
  const env = makeEnv();
  const calls = stubFetch((url) => {
    if (url === "https://api.x.ai/v1/responses") {
      return {
        status: 200,
        body: {
          output: [{ type: "message", content: [{ type: "output_text", text: "live answer" }] }],
          usage: { server_side_tool_usage_details: { web_search_calls: 1, x_search_calls: 1 }, cost_in_usd_ticks: 250000000 },
        },
      };
    }
    return { status: 404, body: { error: `unstubbed ${url}` } };
  });
  try {
    const key = await seedLobby(env);
    const res = await worker.fetch(
      req("/api/dens/lobby/messages", {
        method: "POST",
        headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
        body: JSON.stringify({ body: "what is the latest?", generate: true }),
      }),
      env,
    );
    const body = await res.json();
    assert.deepEqual(body.brain, { tier: "standard", model: "grok-4.20-0309-non-reasoning", search: "used" });
    const rc = calls.xai().find((c) => c.url === "https://api.x.ai/v1/responses");
    assert.deepEqual(JSON.parse(rc.init.body).tools.map((t) => t.type), ["web_search", "x_search"]);
  } finally {
    calls.restore();
  }
});

// ── caps: voice under the USD ceiling ────────────────────────────────────────

test("voiceAllowed: fail closed on ceiling + on ledger error; ticks math", async () => {
  const env = makeEnv();
  assert.equal(voiceSecondsToTicks(0), 0);
  assert.equal(voiceSecondsToTicks(60), 500_000_000); // 1 min × $0.05 × 1e10
  assert.equal(voiceSecondsToTicks(120, 0.05), 1_000_000_000);

  let out = await voiceAllowed(env);
  assert.equal(out.allowed, true);

  env.DB._tables.brain_usage.push({ day: todayKey(), den: "*", kind: "image", calls: 1, ticks: 50_000_000_000 }); // $5.00
  out = await voiceAllowed(env);
  assert.equal(out.allowed, false);
  assert.equal(out.reason, "daily_usd_cap");

  const env2 = makeEnv();
  const orig = env2.DB.prepare.bind(env2.DB);
  env2.DB.prepare = (sql) => {
    if (sql === SQL.brainUsageGlobalTicks) return { bind: () => ({ first: async () => { throw new Error("d1 down"); } }) };
    return orig(sql);
  };
  out = await voiceAllowed(env2);
  assert.equal(out.allowed, false);
  assert.equal(out.reason, "usage_read_failed");
});
