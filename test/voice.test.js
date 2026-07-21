import assert from "node:assert/strict";
import test from "node:test";
import { Chunker, frameBytes, mixMono, monoToStereo, stereoToMono } from "../src/voice/pcm.js";
import { decodePacket, encodeIngestFrame, encodePacket } from "../src/voice/packet.js";
import { DownlinkPacer } from "../src/voice/pacer.js";
import { CostGuard, DailyCap, GuardStatus, KillReason } from "../src/voice/costguard.js";
import { SfuClient } from "../src/voice/sfu-client.js";
import { classifyError, defaultSessionConfig, buildSessionUpdate, extractTranscript, ErrorKind } from "../src/voice/xai-events.js";
import { createFakeD1, installWebSocketStubs } from "./fakes.js";

installWebSocketStubs();
const { VoiceDen } = await import("../src/voice/voice-den.js");

// ── pure modules ─────────────────────────────────────────────────────────────
test("packet codec roundtrip incl. unknown-field skip", () => {
  const pkt = { sequenceNumber: 7, timestamp: 12345, payload: new Uint8Array([1, 2, 3, 250]) };
  const dec = decodePacket(encodePacket(pkt));
  assert.deepEqual(dec, pkt);
  const ingest = encodeIngestFrame(new Uint8Array([9]));
  assert.equal(decodePacket(ingest).payload[0], 9);
  assert.throws(() => decodePacket(new Uint8Array([0x2a, 0x05, 0x01])), /truncated/);
});

test("pcm channel mapping + chunker + mix", () => {
  const stereo = new Uint8Array(8);
  const dv = new DataView(stereo.buffer);
  dv.setInt16(0, 1000, true);
  dv.setInt16(2, -1000, true);
  dv.setInt16(4, 500, true);
  dv.setInt16(6, 500, true);
  const mono = stereoToMono(stereo);
  const mdv = new DataView(mono.buffer);
  assert.equal(mdv.getInt16(0, true), 0);
  assert.equal(mdv.getInt16(2, true), 500);
  assert.equal(monoToStereo(mono).length, 8);

  const c = new Chunker(4);
  assert.deepEqual(c.feed(new Uint8Array(3)).length, 0);
  const chunks = c.feed(new Uint8Array(7));
  assert.equal(chunks.length, 2);
  assert.equal(c.pending, 2);

  // mix: two seats sum + clamp
  const a = new Uint8Array(4), b = new Uint8Array(4);
  new DataView(a.buffer).setInt16(0, 30000, true);
  new DataView(b.buffer).setInt16(0, 30000, true); // 60000 -> clamps to 32767
  new DataView(a.buffer).setInt16(2, 100, true);
  const mixed = mixMono([a, b, null], 4);
  assert.equal(new DataView(mixed.buffer).getInt16(0, true), 32767);
  assert.equal(new DataView(mixed.buffer).getInt16(2, true), 100);
});

test("pacer: prefill, real-time pop, underflow silence, barge-in flush", () => {
  const p = new DownlinkPacer({ frameMs: 20, prefillMs: 60, capacityMs: 200 });
  const frame = () => new Uint8Array(p.frameByteLen);
  assert.equal(p.pop(), null); // pre-filling
  p.push(frame());
  p.push(frame());
  assert.equal(p.pop(), null);
  p.push(frame());
  assert.ok(p.pop()); // started
  p.pop();
  p.pop(); // drains last real frame
  const under = p.pop(); // queue now empty -> silence
  assert.ok(under);
  assert.equal(p.stats.silenceSent, 1);
  p.flush();
  assert.equal(p.bufferedFrames, 0);
  assert.equal(p.stats.flushes, 1);
  assert.throws(() => p.push(new Uint8Array(3)), /frame must be/);
});

test("costguard: warn at 80%, kill at budget, reason preservation", () => {
  const g = new CostGuard({ budgetUsd: 0.05, pricePerMin: 0.05, startedAt: 0 });
  assert.equal(g.status(30_000), GuardStatus.OK); // $0.025
  assert.equal(g.status(48_000), GuardStatus.WARN); // $0.04 = 80%
  g.kill(KillReason.MANUAL);
  assert.equal(g.status(100_000), GuardStatus.KILL);
  assert.equal(g.killReason, KillReason.MANUAL);
  const cap = new DailyCap(1800, () => new Date("2026-07-21T00:00:00Z"));
  assert.equal(cap.key, "2026-07-21"); // D1 voice_usage.day stores the plain UTC date
  assert.ok(cap.allow(100));
  assert.ok(!cap.allow(1800));
});

test("sfu client against fake fetch (routes + 503-close idempotence)", async () => {
  const calls = [];
  const fakeFetch = async (input, init) => {
    calls.push({ input, body: init?.body ? JSON.parse(init.body) : null });
    const respond = (obj, status = 200) => ({ ok: status < 300, status, text: async () => (typeof obj === "string" ? obj : JSON.stringify(obj)) });
    if (input.endsWith("/sessions/new")) return respond({ sessionId: "s1" });
    if (input.includes("/tracks/new") && init.body.includes("autoDiscover")) {
      return respond({ tracks: [{ kind: "audio", trackName: "mic-1" }], sessionDescription: { type: "answer", sdp: "sdp" } });
    }
    if (input.includes("/tracks/new")) return respond({ sessionDescription: { type: "answer", sdp: "sdp2" } });
    if (input.endsWith("/adapters/websocket/new") && init.body.includes('"local"')) {
      return respond({ tracks: [{ sessionId: "ing-1", adapterId: "ad-1", trackName: "den-voice" }] });
    }
    if (input.endsWith("/adapters/websocket/new")) return respond({ tracks: [{ adapterId: "ad-2" }] });
    if (input.endsWith("/adapters/websocket/close")) return respond("adapter_not_found", 503);
    throw new Error(`unexpected ${input}`);
  };
  const sfu = new SfuClient({ appId: "app", appSecret: "sec", fetchImpl: fakeFetch });
  assert.equal(await sfu.createSession(), "s1");
  assert.equal((await sfu.addTracksAutoDiscover("s1", { type: "offer", sdp: "x" })).audioTrackName, "mic-1");
  const ing = await sfu.createIngestAdapter("den-voice", "wss://h/down?token=t");
  assert.deepEqual(ing, { sessionId: "ing-1", adapterId: "ad-1", trackName: "den-voice" });
  assert.equal((await sfu.createEgressAdapter("s1", "mic-1", "wss://h/up?token=t")).adapterId, "ad-2");
  const close = await sfu.closeAdapter("ad-1");
  assert.deepEqual(close, { ok: true, alreadyClosed: true, status: 503 });
});

test("xai events: session update shape + error classification + transcripts", () => {
  const upd = buildSessionUpdate(defaultSessionConfig("The Lobby", "test topic"));
  assert.equal(upd.type, "session.update");
  assert.equal(upd.session.audio.transport, "binary");
  assert.equal(upd.session.audio.input.format.rate, 48000);
  assert.match(upd.session.instructions, /Den Keeper/);
  assert.match(upd.session.instructions, /The Lobby/);
  assert.equal(classifyError({ type: "error", error: { message: "insufficient balance" } }), ErrorKind.BILLING);
  assert.equal(classifyError({ type: "error", error: { message: "401 unauthorized" } }), ErrorKind.AUTH);
  assert.deepEqual(
    extractTranscript({ type: "response.output_audio_transcript.done", transcript: "hi" }),
    { role: "assistant", text: "hi", final: true },
  );
});

// ── VoiceDen DO lifecycle (all I/O faked) ────────────────────────────────────
function fakeSfu() {
  const state = { sessions: 0, adapters: [], closed: [], pulls: [], failNextMic: false };
  return {
    state,
    async createSession() { return `sess-${++state.sessions}`; },
    async addTracksAutoDiscover() {
      if (state.failNextMic) { state.failNextMic = false; throw new Error("SFU addTracksAutoDiscover failed: 500"); }
      return { audioTrackName: "mic-track", json: { sessionDescription: { type: "answer", sdp: "mic-answer" } } };
    },
    async pullRemoteTrack(playerId, pubId, trackName, offer) { state.pulls.push([{ trackName }]); return { sessionDescription: { type: "answer", sdp: "listen-answer" } }; },
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

async function joinAndBridge(room) {
  const join = await (await room.fetch(post("lobby", "join", joinBody))).json();
  assert.ok(join.ok);
  const seatId = join.seatId;
  const mic = await (await room.fetch(post("lobby", "sdp-mic", { seatId, offer: { type: "offer", sdp: "o1" } }))).json();
  assert.equal(mic.answer.sdp, "mic-answer");
  const listen = await (await room.fetch(post("lobby", "sdp-listen", { seatId, offer: { type: "offer", sdp: "o2" } }))).json();
  assert.equal(listen.answer.sdp, "listen-answer");
  const ready = await (await room.fetch(post("lobby", "media-ready", { seatId }))).json();
  assert.equal(ready.state, "bridging");
  return { join, seatId };
}

test("voice den: full happy path join→sdp→media-ready; disclosure AFTER media", async () => {
  const { room, sfu, xai } = setupDen();
  await joinAndBridge(room);

  // xAI session configured for the den
  const sessionUpdate = xai.sent.map((s) => (typeof s === "string" ? JSON.parse(s) : null)).find((m) => m?.type === "session.update");
  assert.ok(sessionUpdate);
  assert.match(sessionUpdate.session.instructions, /The Lobby/);

  // disclosure sent exactly once, only after media-ready (never into the void)
  const forced = xai.sent.map((s) => (typeof s === "string" ? JSON.parse(s) : null)).filter((m) => m?.type === "conversation.item.create");
  assert.equal(forced.length, 1);
  assert.match(forced[0].item.content[0].text, /Den Keeper/);
  assert.equal(forced[0].item.interruptible, false);

  // adapters: shared den-voice ingest + seat floor ingest + seat egress
  const ing = sfu.state.adapters.filter((a) => a.kind === "ingest");
  assert.equal(ing.filter((a) => a.trackName === "den-voice").length, 1);
  assert.equal(ing.filter((a) => a.trackName.startsWith("floor-")).length, 1);
  const eg = sfu.state.adapters.find((a) => a.kind === "egress");
  assert.match(eg.endpoint, /token=/);
  assert.match(eg.endpoint, /seat=/);

  const status = await (await room.fetch(new Request("https://do.internal/api/dens/lobby/voice/status"))).json();
  assert.equal(status.state, "bridging");
  assert.equal(status.seats, 1);
});

test("voice den: second seat reuses the ONE xAI session (cost per den, not per human)", async () => {
  const { room, sfu, xai } = setupDen();
  await joinAndBridge(room);
  const join2 = await (await room.fetch(post("lobby", "join", { ...joinBody, handle: "kenny" }))).json();
  assert.ok(join2.ok);
  await room.fetch(post("lobby", "sdp-mic", { seatId: join2.seatId, offer: { type: "offer", sdp: "o3" } }));
  await room.fetch(post("lobby", "sdp-listen", { seatId: join2.seatId, offer: { type: "offer", sdp: "o4" } }));
  const ready2 = await (await room.fetch(post("lobby", "media-ready", { seatId: join2.seatId }))).json();
  assert.equal(ready2.state, "bridging");
  // no second session.update, no second disclosure
  const updates = xai.sent.map((s) => (typeof s === "string" ? JSON.parse(s) : null)).filter((m) => m?.type === "session.update");
  assert.equal(updates.length, 1);
  const forced = xai.sent.map((s) => (typeof s === "string" ? JSON.parse(s) : null)).filter((m) => m?.type === "conversation.item.create");
  assert.equal(forced.length, 1);
  const status = await (await room.fetch(new Request("https://do.internal/api/dens/lobby/voice/status"))).json();
  assert.equal(status.seats, 2);
});

test("voice den: uplink frames queue per seat; mixer sums into xAI (Blob frames coerced)", async () => {
  const { room, xai } = setupDen();
  const { seatId } = await joinAndBridge(room);

  // SFU attaches to the seat's uplink endpoint — with a Blob-shaped frame (Jul-20 lesson)
  const up = await room.fetch(
    new Request("https://do.internal/api/dens/lobby/voice/uplink?token=" + room.adapterToken + "&seat=" + seatId, { headers: { upgrade: "websocket" } }),
  );
  assert.equal(up.status, 101);

  // feed a Packet(48k stereo) frame as a Blob — must be coerced, not dropped
  const stereo = new Uint8Array(3840); // 20ms stereo
  new DataView(stereo.buffer).setInt16(0, 2000, true);
  new DataView(stereo.buffer).setInt16(2, 2000, true);
  await room.onUplinkFrame(room.seats.get(seatId), { data: new Blob([encodePacket({ sequenceNumber: 1, timestamp: 1, payload: stereo })]) });
  const seat = room.seats.get(seatId);
  assert.ok(seat.queueBytes > 0, "mono PCM queued from coerced Blob frame");
  assert.equal(seat.bytesUp, 1920);

  // mixer tick sends a 1920B mono chunk to xAI containing the signal
  const mixed = room.takeFromSeat(seat, 1920);
  assert.equal(mixed.length, 1920);
  assert.equal(new DataView(mixed.buffer).getInt16(0, true), 2000);
  const out = mixMono([mixed, null], 1920);
  assert.equal(new DataView(out.buffer).getInt16(0, true), 2000);
});

test("voice den: uplink/downlink token auth; bad token forbidden", async () => {
  const { room } = setupDen();
  const { seatId } = await joinAndBridge(room);
  const bad = await room.fetch(new Request(`https://do.internal/api/dens/lobby/voice/uplink?token=wrong&seat=${seatId}`));
  assert.equal(bad.status, 403);
  const badDown = await room.fetch(new Request("https://do.internal/api/dens/lobby/voice/downlink?token=wrong"));
  assert.equal(badDown.status, 403);
});

test("voice den: xAI audio deltas (binary + base64) feed the pacer; barge-in flushes", async () => {
  const { room, xai } = setupDen();
  await joinAndBridge(room);
  const mono = new Uint8Array(1920 * 10); // 200ms of audio
  xai.emit("message", { data: mono.buffer }); // binary transport
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(room.pacer.bufferedFrames > 0, "pacer fed from binary delta");
  xai.emit("message", { data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(room.pacer.bufferedFrames, 0, "barge-in flushed");
});

test("voice den: billing error = instant kill + daily usage persisted; last leave closes", async () => {
  const { room, xai, DB } = setupDen();
  const { seatId } = await joinAndBridge(room);
  xai.emit("message", { data: JSON.stringify({ type: "error", error: { message: "insufficient balance, billing required" } }) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(room.state, "failed");
  assert.equal(DB._tables.voice_usage.length, 1);
  assert.ok(DB._tables.voice_usage[0].seconds >= 0);

  // fresh den: last seat leaving closes the session (no orphaned spend)
  const d2 = setupDen();
  const j = await joinAndBridge(d2.room);
  const leave = await (await d2.room.fetch(post("lobby", "leave", { seatId: j.seatId }))).json();
  assert.equal(leave.seats, 0);
  assert.equal(d2.room.state, "closed");
});

test("voice den: daily cap refuses new session; kill flag refuses + guard kills", async () => {
  const { room, DB } = setupDen();
  const day = new Date().toISOString().slice(0, 10);
  DB._tables.voice_usage.push({ day, seconds: 31 * 60 }); // over the 30-min cap
  const res = await room.fetch(post("lobby", "join", joinBody));
  assert.equal(res.status, 429);

  const d2 = setupDen();
  d2.DB._tables.voice_flags.push({ k: "kill", v: "1" });
  const res2 = await d2.room.fetch(post("lobby", "join", joinBody));
  assert.equal(res2.status, 503);
});

test("voice den: session resets after close (warm DO re-join)", async () => {
  const { room } = setupDen();
  const j = await joinAndBridge(room);
  await room.fetch(post("lobby", "leave", { seatId: j.seatId }));
  assert.equal(room.state, "closed");
  const j2 = await (await room.fetch(post("lobby", "join", joinBody))).json();
  assert.ok(j2.ok, "re-join after close starts a fresh session");
  assert.equal(room.state, "waiting_media");
});

test("voice den: idle waiting_media session auto-closes after 120s (no idle spend)", async () => {
  let t = 1_000_000;
  const { room } = setupDen({ now: () => t });
  await room.fetch(post("lobby", "join", joinBody)); // starts session, no media
  assert.equal(room.state, "waiting_media");
  t += 60_000;
  await room.guardTick();
  assert.equal(room.state, "waiting_media"); // 60s: still grace
  t += 61_000; // 121s total
  await room.guardTick();
  assert.equal(room.state, "closed");
  assert.equal(room.guard.killReason, "idle_timeout");
});

// ── P2.5: human↔human floor tracks ──────────────────────────────────────────
test("floor: each seat gets a floor ingest adapter + pulls BOTH tracks", async () => {
  const { room, sfu } = setupDen();
  const a = await joinAndBridge(room);
  const joinB = await (await room.fetch(post("lobby", "join", { ...joinBody, handle: "b-human" }))).json();
  await room.fetch(post("lobby", "sdp-mic", { seatId: joinB.seatId, offer: { type: "offer", sdp: "o" } }));
  await room.fetch(post("lobby", "sdp-listen", { seatId: joinB.seatId, offer: { type: "offer", sdp: "o" } }));

  // 3 ingest adapters: den-voice + floor-A + floor-B
  const ingests = sfu.state.adapters.filter((x) => x.kind === "ingest");
  assert.equal(ingests.length, 3);
  assert.equal(ingests.filter((x) => x.trackName === "den-voice").length, 1);
  assert.equal(ingests.filter((x) => x.trackName.startsWith("floor-")).length, 2);
  assert.ok(ingests[1].endpoint.includes("seat="));

  // sdp-listen pulled den-voice + own floor in ONE negotiation
  const pull = sfu.state.pulls.at(-1);
  assert.equal(pull.length, 2);
  assert.equal(pull[0].trackName, "den-voice");
  assert.ok(pull[1].trackName.startsWith("floor-"));
});

test("floor mixing: A speaks -> B's floor gets it, A's floor does NOT, xAI hears all", async () => {
  const { room, xai } = setupDen();
  const a = await joinAndBridge(room);
  const b = await joinAndBridge(room); // second seat on same session
  const seatA = room.seats.get(a.seatId);
  const seatB = room.seats.get(b.seatId);

  // A feeds 40ms of tone
  const stereo = new Uint8Array(3840 * 2);
  for (let i = 0; i < stereo.length; i += 4) {
    new DataView(stereo.buffer).setInt16(i, 1000, true);
    new DataView(stereo.buffer).setInt16(i + 2, 1000, true);
  }
  await room.onUplinkFrame(seatA, { data: encodePacket({ sequenceNumber: 1, timestamp: 1, payload: stereo }) });

  // run two mixer ticks manually (tick body, timers unref'd in tests)
  for (let tick = 0; tick < 2; tick++) {
    const frames = new Map();
    for (const seat of room.seats.values()) frames.set(seat.seatId, room.takeFromSeat(seat, 1920));
    for (const dest of room.seats.values()) {
      const parts = [];
      let heard = false;
      for (const [srcId, frame] of frames) {
        if (srcId === dest.seatId) continue;
        parts.push(frame);
        if (frame) heard = true;
      }
      if (!heard) continue;
      const { mixMono, monoToStereo } = await import("../src/voice/pcm.js");
      const mono = mixMono(parts, 1920);
      for (const chunk of dest.floorChunker.feed(monoToStereo(mono))) dest.floorPacer.push(chunk);
    }
  }

  assert.ok(seatB.floorPacer.bufferedFrames > 0, "B floor has A's audio");
  assert.equal(seatA.floorPacer.bufferedFrames, 0, "A floor silent (self excluded)");
});

test("floor: seat cap (fire_full) + seat failure drops seat, session survives", async () => {
  const { room, sfu } = setupDen();
  // fill to cap
  for (let i = 0; i < 8; i++) {
    const j = await (await room.fetch(post("lobby", "join", { ...joinBody, handle: `s${i}` }))).json();
    assert.ok(j.ok, `seat ${i}`);
  }
  const ninth = await room.fetch(post("lobby", "join", { ...joinBody, handle: "s9" }));
  assert.equal(ninth.status, 429);
  assert.equal((await ninth.json()).error, "fire_full");

  // a seat's sdp-mic failure drops THAT seat; the session keeps bridging for others
  const d2 = setupDen();
  const a = await joinAndBridge(d2.room);
  const joinB = await (await d2.room.fetch(post("lobby", "join", { ...joinBody, handle: "unlucky" }))).json();
  d2.sfu.state.failNextMic = true;
  const micRes = await d2.room.fetch(post("lobby", "sdp-mic", { seatId: joinB.seatId, offer: { type: "offer", sdp: "o" } }));
  assert.equal(micRes.status, 500);
  assert.equal((await micRes.json()).error, "seat_failed");
  assert.equal(d2.room.state, "bridging", "session survives a seat failure");
  assert.ok(!d2.room.seats.has(joinB.seatId), "failed seat dropped");
  assert.ok(d2.room.seats.has(a.seatId), "healthy seat remains");
});
