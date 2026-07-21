// the-pack — voice wave 2 (2026-07-21): Voice Agent API tools inside voice
// sessions (web/X live search + den file_search), per-den minute caps, and
// voice spend inside the pack's daily USD ceiling. Fail-closed everywhere.
// Hermetic: same all-faked DO harness as voice.test.js.
import assert from "node:assert/strict";
import test from "node:test";
import { SQL } from "../src/db.js";
import { todayKey } from "../src/caps.js";
import { defaultSessionConfig, buildSessionUpdate } from "../src/voice/xai-events.js";
import { createFakeD1, installWebSocketStubs } from "./fakes.js";

installWebSocketStubs();
const { VoiceDen } = await import("../src/voice/voice-den.js");

function fakeSfu() {
  const state = { sessions: 0, adapters: [], closed: [], pulls: [] };
  return {
    state,
    async createSession() { return `sess-${++state.sessions}`; },
    async addTracksAutoDiscover() {
      return { audioTrackName: "mic-track", json: { sessionDescription: { type: "answer", sdp: "mic-answer" } } };
    },
    async pullRemoteTracks(playerId, trackSpecs, offer) { state.pulls.push(trackSpecs); return { sessionDescription: { type: "answer", sdp: "listen-answer" } }; },
    async createIngestAdapter(trackName, endpoint) {
      state.adapters.push({ kind: "ingest", trackName, endpoint });
      return { sessionId: `ing-${state.adapters.length}`, adapterId: `ad-ing-${state.adapters.length}`, trackName };
    },
    async createEgressAdapter(sessionId, trackName, endpoint) { state.adapters.push({ kind: "egress", sessionId, trackName, endpoint }); return { adapterId: `ad-eg-${state.adapters.length}`, json: {} }; },
    async closeAdapter(id) { state.closed.push(id); return { ok: true, alreadyClosed: false, status: 200 }; },
  };
}

function fakeXai() {
  const sent = [];
  const listeners = {};
  return {
    sent,
    listeners,
    send(d) { sent.push(d); },
    close() {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    emit(type, event) { for (const fn of listeners[type] || []) fn(event); },
  };
}

function setupDen(opts = {}) {
  const DB = createFakeD1();
  const sfu = fakeSfu();
  const xai = fakeXai();
  const ctx = {
    id: { toString: () => "voice-do" },
    storage: { async get() { return undefined; }, async put() {} },
    waitUntil(p) { p.catch(() => {}); },
  };
  const env = {
    DB,
    REALTIME_SFU_APP_ID: "app",
    REALTIME_SFU_SECRET: "sec",
    XAI_API_KEY: "key",
    HOSTNAME: "pack.test",
    ...(opts.env || {}),
  };
  const room = new VoiceDen(ctx, env, {
    connectXai: async () => xai,
    sfuFactory: () => sfu,
    now: opts.now,
    upgradeResponse: (client) => {
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, "status", { value: 101 });
      r.webSocket = client;
      return r;
    },
  });
  return { DB, sfu, xai, room };
}

const joinBody = { handle: "judy", kind: "human", denName: "The Lobby", denTopic: "test" };
const post = (slug, action, body) =>
  new Request(`https://do.internal/api/dens/${slug}/voice/${action}`, { method: "POST", body: JSON.stringify(body) });
const sessionUpdates = (xai) =>
  xai.sent.map((s) => (typeof s === "string" ? JSON.parse(s) : null)).filter((m) => m?.type === "session.update");

// ── session config: tools seam ───────────────────────────────────────────────

test("session config: no tools → no tools key (pre-wave-2 wire shape)", () => {
  const upd = buildSessionUpdate(defaultSessionConfig("The Lobby", "topic"));
  assert.equal("tools" in upd.session, false);
  const upd2 = buildSessionUpdate(defaultSessionConfig("The Lobby", "topic", { tools: [] }));
  assert.equal("tools" in upd2.session, false);
});

test("session config: tools pass through (Voice Agent API shape)", () => {
  const tools = [
    { type: "web_search" },
    { type: "x_search" },
    { type: "file_search", vector_store_ids: ["collection_x"], max_num_results: 5 },
  ];
  const upd = buildSessionUpdate(defaultSessionConfig("The Lobby", "topic", { tools }));
  assert.deepEqual(upd.session.tools, tools);
});

// ── session start: tools, USD ceiling, per-den cap ──────────────────────────

test("join: default-on live tools in the voice session (no den docs → web/X only)", async () => {
  const { xai, room } = setupDen();
  const join = await (await room.fetch(post("lobby", "join", joinBody))).json();
  assert.ok(join.ok);
  const upd = sessionUpdates(xai)[0];
  assert.deepEqual(upd.session.tools.map((t) => t.type), ["web_search", "x_search"]);
});

test("join: den with ready docs → file_search in the voice session too", async () => {
  const { DB, xai, room } = setupDen();
  DB._tables.dens.push({
    id: "den-1", slug: "lobby", name: "The Lobby", topic: "", brain_tier: "standard",
    search_tools: 1, created_by: "seed", created_at: "2026-07-21",
  });
  DB._tables.den_collections.push({ den_id: "den-1", collection_id: "collection_voice-1", created_at: "2026-07-21" });
  DB._tables.den_docs.push({
    id: "doc-1", den_id: "den-1", file_id: "file_v-1", name: "Lore", bytes: 50,
    status: "ready", added_by: "seed", created_at: "2026-07-21",
  });
  const join = await (await room.fetch(post("lobby", "join", joinBody))).json();
  assert.ok(join.ok);
  const tools = sessionUpdates(xai)[0].session.tools;
  const fs = tools.find((t) => t.type === "file_search");
  assert.ok(fs, "file_search present");
  assert.deepEqual(fs.vector_store_ids, ["collection_voice-1"]);
});

test("join: PACK_VOICE_TOOLS=0 → no tools key at all (kill switch)", async () => {
  const { xai, room } = setupDen({ env: { PACK_VOICE_TOOLS: "0" } });
  const join = await (await room.fetch(post("lobby", "join", joinBody))).json();
  assert.ok(join.ok);
  assert.equal("tools" in sessionUpdates(xai)[0].session, false);
});

test("join: PACK_VOICE_SEARCH_DEFAULT=0 kills web/X but keeps den file_search", async () => {
  const { DB, xai, room } = setupDen({ env: { PACK_VOICE_SEARCH_DEFAULT: "0" } });
  DB._tables.dens.push({
    id: "den-1", slug: "lobby", name: "The Lobby", topic: "", brain_tier: "standard",
    search_tools: 1, created_by: "seed", created_at: "2026-07-21",
  });
  DB._tables.den_collections.push({ den_id: "den-1", collection_id: "collection_voice-1", created_at: "2026-07-21" });
  DB._tables.den_docs.push({
    id: "doc-1", den_id: "den-1", file_id: "file_v-1", name: "Lore", bytes: 50,
    status: "ready", added_by: "seed", created_at: "2026-07-21",
  });
  const join = await (await room.fetch(post("lobby", "join", joinBody))).json();
  assert.ok(join.ok);
  assert.deepEqual(sessionUpdates(xai)[0].session.tools.map((t) => t.type), ["file_search"]);
});

test("join: daily USD ceiling reached → 429 daily_usd_cap, NO xAI session (fail closed)", async () => {
  const { DB, xai, room } = setupDen();
  DB._tables.brain_usage.push({ day: todayKey(), den: "*", kind: "image", calls: 1, ticks: 55_000_000_000 }); // $5.50
  const res = await room.fetch(post("lobby", "join", joinBody));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, "daily_usd_cap");
  assert.equal(sessionUpdates(xai).length, 0, "no paid voice session started");
});

test("join: usage ledger unreadable → 429 usage_ledger_unavailable (fail closed)", async () => {
  const { DB, xai, room } = setupDen();
  const orig = DB.prepare.bind(DB);
  DB.prepare = (sql) => {
    if (sql === SQL.brainUsageGlobalTicks) return { bind: () => ({ first: async () => { throw new Error("d1 down"); } }) };
    return orig(sql);
  };
  const res = await room.fetch(post("lobby", "join", joinBody));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, "usage_ledger_unavailable");
  assert.equal(sessionUpdates(xai).length, 0);
});

test("join: per-den minute cap → 429 den_daily_cap_exceeded; other dens unaffected", async () => {
  const { DB, xai, room } = setupDen({ env: { PACK_VOICE_DEN_MIN_CAP: "10" } });
  DB._tables.voice_usage_den.push({ day: todayKey(), den: "lobby", seconds: 600 });
  const res = await room.fetch(post("lobby", "join", joinBody));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, "den_daily_cap_exceeded");
  assert.equal(sessionUpdates(xai).length, 0);

  // A different den on a fresh DO with the same ledger is NOT capped.
  const second = setupDen({ env: { PACK_VOICE_DEN_MIN_CAP: "10" } });
  second.DB._tables.voice_usage_den.push({ day: todayKey(), den: "lobby", seconds: 600 });
  const res2 = await second.room.fetch(post("other-den", "join", joinBody));
  assert.equal((await res2.json()).ok, true);
});

test("teardown: voice seconds logged per-den AND as USD-ceiling ticks (kind voice)", async () => {
  const t0 = Date.now();
  let clock = t0;
  const { DB, room } = setupDen({ now: () => clock });
  const join = await (await room.fetch(post("lobby", "join", joinBody))).json();
  assert.ok(join.ok);
  clock = t0 + 62_000; // 62s session elapses before the kill
  await room.fetch(post("lobby", "kill", {}));
  const denRow = DB._tables.voice_usage_den.find((r) => r.day === todayKey() && r.den === "lobby");
  assert.ok(denRow.seconds >= 60 && denRow.seconds <= 64, `per-den seconds ~62, got ${denRow.seconds}`);
  const voiceRow = DB._tables.brain_usage.find((r) => r.day === todayKey() && r.den === "lobby" && r.kind === "voice");
  assert.ok(voiceRow, "voice ticks row exists");
  // 62s × $0.05/min ≈ $0.0517 ≈ 5.17e8 ticks (±5%)
  assert.ok(voiceRow.ticks > 490_000_000 && voiceRow.ticks < 545_000_000, `ticks ≈ 5.17e8, got ${voiceRow.ticks}`);
  const globalRow = DB._tables.brain_usage.find((r) => r.day === todayKey() && r.den === "*" && r.kind === "voice");
  assert.equal(globalRow.ticks, voiceRow.ticks, "global rollup matches");
  // Global voice_usage (seconds) still written — pre-wave-2 ledger intact.
  assert.ok(DB._tables.voice_usage.find((r) => r.day === todayKey()).seconds >= 60);
});
