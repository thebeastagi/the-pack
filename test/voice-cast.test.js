// voice-den branch — multi-AI voice casts (fireside-voices: Ash + Birch).
// All I/O faked; covers cast resolution, per-character session config,
// N-leg lifecycle, cross-feed ("everyone but yourself"), human floor
// priority gate, leg-seconds accounting, transcripts, rekindle bounds.
import assert from "node:assert/strict";
import test from "node:test";
import { castForDen, HUMAN_TALK_LEVEL, PRICE_PER_MIN_USD, VOICE_CASTS } from "../src/voice/config.js";
import { buildSessionUpdate, characterSessionConfig } from "../src/voice/xai-events.js";
import { mixMono } from "../src/voice/pcm.js";
import { encodePacket } from "../src/voice/packet.js";
import { createFakeD1, installWebSocketStubs } from "./fakes.js";

installWebSocketStubs();
const { VoiceDen } = await import("../src/voice/voice-den.js");

const FRAME = 1920; // 20ms mono 48k
const microtask = () => new Promise((r) => setImmediate(r));

// ── cast resolution + session config ────────────────────────────────────────
test("castForDen: built-in fireside cast, default dens stay legacy (null)", () => {
  assert.equal(castForDen("lobby", {}), null);
  const cast = castForDen("fireside-voices", {});
  assert.equal(cast.length, 2);
  assert.deepEqual(cast.map((c) => c.name), ["Ash", "Birch"]);
  assert.equal(cast[0].voice, "orion");
  assert.equal(cast[0].speed, 0.8);
  assert.equal(cast[0].vadSilenceMs, 1100);
  assert.equal(cast[1].voice, "sirius");
  assert.equal(cast[1].speed, 0.8); // 1.15→1.0→0.8 per Jane esc-3771 (Jul 24): still a bit fast, try 0.8
  assert.match(cast[0].opening, /A I (wolves|voices)/);
  assert.equal(cast[0].tools, false);
});

test("castForDen: env JSON override, malformed override ignored, hard bounds", () => {
  const env = {
    PACK_VOICE_CAST_JSON: JSON.stringify({
      "my-den": [
        { name: "X".repeat(50), voice: "ara", speed: 9, vadSilenceMs: 5, persona: "p" },
        { name: "bad" }, // no persona -> filtered
      ],
    }),
  };
  const cast = castForDen("my-den", env);
  assert.equal(cast.length, 1);
  assert.equal(cast[0].name.length, 24);
  assert.equal(cast[0].speed, 1.5); // clamped
  assert.equal(cast[0].vadSilenceMs, 300); // clamped
  assert.equal(castForDen("fireside-voices", env).length, 2); // built-ins still there
  assert.equal(castForDen("my-den", { PACK_VOICE_CAST_JSON: "{not json" }), null);
  // >4 characters are hard-bounded (never more than 4 paid legs)
  const big = { PACK_VOICE_CAST_JSON: JSON.stringify({ d: Array.from({ length: 9 }, (_, i) => ({ name: `n${i}`, persona: "p" })) }) };
  assert.equal(castForDen("d", big).length, 4);
});

test("characterSessionConfig: voice/speed/VAD flow into the session.update wire shape", () => {
  const [ash, birch] = VOICE_CASTS["fireside-voices"];
  const upd = buildSessionUpdate(characterSessionConfig(ash, "Fireside", "topic"));
  assert.equal(upd.session.voice, "orion");
  assert.equal(upd.session.audio.output.speed, 0.8);
  assert.equal(upd.session.turn_detection.silence_duration_ms, 1100);
  assert.match(upd.session.instructions, /Ash/);
  assert.ok(!("tools" in upd.session), "cast legs carry no paid tools by default");
  const upd2 = buildSessionUpdate(characterSessionConfig(birch, "Fireside", ""));
  assert.equal(upd2.session.audio.output.speed, 0.8); // Birch@0.8 sends speed key again (≠1.0)
  // legacy shape unchanged: no speed key when speed is 1.0/absent
  const legacy = buildSessionUpdate(characterSessionConfig({ ...ash, speed: 1 }, "d", ""));
  assert.ok(!("speed" in legacy.session.audio.output));
});

// ── DO harness (multi-connect) ──────────────────────────────────────────────
function fakeSfu() {
  const state = { sessions: 0, adapters: [], closed: [], pulls: [] };
  return {
    state,
    async createSession() { return `sess-${++state.sessions}`; },
    async addTracksAutoDiscover() {
      return { audioTrackName: "mic-track", json: { sessionDescription: { type: "answer", sdp: "mic-answer" } } };
    },
    async pullRemoteTracks(id, specs) { state.pulls.push(specs); return { sessionDescription: { type: "answer", sdp: "listen-answer" } }; },
    async createIngestAdapter(trackName, endpoint) {
      state.adapters.push({ kind: "ingest", trackName, endpoint });
      return { sessionId: `ing-${state.adapters.length}`, adapterId: `ad-ing-${state.adapters.length}`, trackName };
    },
    async createEgressAdapter(sessionId, trackName, endpoint) { state.adapters.push({ kind: "egress", sessionId, trackName, endpoint }); return { adapterId: `ad-eg-${state.adapters.length}` }; },
    async closeAdapter(id) { state.closed.push(id); return { ok: true }; },
  };
}

function fakeXai(label) {
  const sent = [];
  const listeners = {};
  return {
    label,
    sent,
    closed: 0,
    send(d) { sent.push(d); },
    close() { this.closed++; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    emit(type, event) { for (const fn of listeners[type] || []) fn(event); },
    jsonSent(type) { return sent.filter((s) => typeof s === "string").map((s) => JSON.parse(s)).filter((m) => m.type === type); },
    binSent() { return sent.filter((s) => typeof s !== "string"); },
  };
}

function setupCastDen(opts = {}) {
  const DB = createFakeD1();
  const sfu = fakeSfu();
  const xais = [];
  const ctx = { id: { toString: () => "voice-do" }, storage: { async get() {}, async put() {} }, waitUntil(p) { p.catch(() => {}); } };
  const env = { DB, REALTIME_SFU_APP_ID: "app", REALTIME_SFU_SECRET: "sec", XAI_API_KEY: "key", HOSTNAME: "pack.test", ...(opts.env || {}) };
  const room = new VoiceDen(ctx, env, {
    connectXai: async () => { const x = fakeXai(`leg-${xais.length}`); xais.push(x); return x; },
    sfuFactory: () => sfu,
    now: opts.now,
    upgradeResponse: (client) => {
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, "status", { value: 101 });
      r.webSocket = client;
      return r;
    },
  });
  return { DB, sfu, xais, room };
}

const post = (slug, action, body) =>
  new Request(`https://do.internal/api/dens/${slug}/voice/${action}`, { method: "POST", body: JSON.stringify(body) });
const joinBody = { handle: "judy", kind: "human", denName: "Fireside Voices", denTopic: "AI wolves by the fire" };

async function joinAndBridge(room, slug = "fireside-voices", body = joinBody) {
  const join = await (await room.fetch(post(slug, "join", body))).json();
  assert.ok(join.ok, JSON.stringify(join));
  const seatId = join.seatId;
  await room.fetch(post(slug, "sdp-mic", { seatId, offer: { type: "offer", sdp: "o1" } }));
  await room.fetch(post(slug, "sdp-listen", { seatId, offer: { type: "offer", sdp: "o2" } }));
  const ready = await (await room.fetch(post(slug, "media-ready", { seatId }))).json();
  assert.equal(ready.state, "bridging");
  return seatId;
}

/** Feed `frames` × 20ms of leg TTS audio (amplitude amp) into a leg's fake ws. */
function emitLegAudio(xai, frames, amp = 4000) {
  const mono = new Uint8Array(FRAME * frames);
  const dv = new DataView(mono.buffer);
  for (let i = 0; i < mono.length / 2; i++) dv.setInt16(i * 2, amp, true);
  xai.emit("message", { data: mono.buffer });
}

function loudSeatPacket(frames, amp = 4000) {
  const stereo = new Uint8Array(3840 * frames);
  const dv = new DataView(stereo.buffer);
  for (let i = 0; i < stereo.length / 2; i++) dv.setInt16(i * 2, amp, true);
  return encodePacket({ sequenceNumber: 1, timestamp: 1, payload: stereo });
}

// ── lifecycle ───────────────────────────────────────────────────────────────
test("cast den: TWO legs connect, each with its own character session.update; opening once on leg0", async () => {
  const { room, xais } = setupCastDen();
  await joinAndBridge(room);
  assert.equal(xais.length, 2, "one xAI session per character");
  const [a, b] = xais;
  const ua = a.jsonSent("session.update"), ub = b.jsonSent("session.update");
  assert.equal(ua.length, 1);
  assert.equal(ub.length, 1);
  assert.equal(ua[0].session.voice, "orion");
  assert.equal(ua[0].session.audio.output.speed, 0.8);
  assert.equal(ub[0].session.voice, "sirius");
  assert.equal(ub[0].session.audio.output.speed, 0.8); // Birch@0.8 per Jane esc-3771
  // opening/disclosure: exactly once, ONLY leg0, non-interruptible, discloses AI
  const fa = a.jsonSent("conversation.item.create"), fb = b.jsonSent("conversation.item.create");
  assert.equal(fa.length, 1);
  assert.equal(fb.length, 0);
  assert.equal(fa[0].item.interruptible, false);
  assert.match(fa[0].item.content[0].text, /A I (wolves|voices)/);
  // guard prices wall-clock at 2 × $0.05/min
  assert.equal(room.guard.pricePerMin, 2 * PRICE_PER_MIN_USD);
  // status reports the cast
  const st = room.statusRecord();
  assert.deepEqual(st.cast.map((c) => c.name), ["Ash", "Birch"]);
  assert.equal(st.humanTalking, false);
});

test("cast den: cross-feed — leg A audio reaches leg B's ears and den-voice, never its own ears", async () => {
  const { room, xais } = setupCastDen();
  await joinAndBridge(room);
  const [a, b] = xais;
  a.binSent().length = 0;
  emitLegAudio(a, 40); // 800ms of Ash TTS — well past the 300ms pacer prefill
  await microtask();
  assert.ok(room.legs[0].pacer.bufferedFrames >= 15, "leg pacer holds the burst");
  const aBefore = a.binSent().length, bBefore = b.binSent().length;
  let toneToB = 0, toneToA = 0, denVoiceFrames = 0;
  const before = room.pacer.bufferedFrames;
  for (let t = 0; t < 10; t++) room.mixerTick();
  denVoiceFrames = room.pacer.bufferedFrames - before;
  for (const buf of b.binSent().slice(bBefore)) {
    if (new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0).getInt16(0, true) !== 0) toneToB++;
  }
  for (const buf of a.binSent().slice(aBefore)) {
    if (new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0).getInt16(0, true) !== 0) toneToA++;
  }
  assert.ok(toneToB >= 8, `B hears A's tone (${toneToB}/10 ticks)`);
  assert.equal(toneToA, 0, "A never hears itself");
  assert.ok(denVoiceFrames >= 8, `den-voice track carries the AI mix (${denVoiceFrames})`);
  // uplink is CONTINUOUS: both legs got a frame every tick (silence included)
  assert.equal(a.binSent().length - aBefore, 10);
  assert.equal(b.binSent().length - bBefore, 10);
});

test("cast den: human floor priority — onset flushes + drops AI output, release restores", async () => {
  const { room, xais } = setupCastDen();
  const seatId = await joinAndBridge(room);
  const seat = room.seats.get(seatId);
  const [a] = xais;
  emitLegAudio(a, 40);
  await microtask();
  assert.ok(room.legs[0].pacer.bufferedFrames > 0);

  // human speaks loud: feed 10 frames of hot mic audio
  await room.onUplinkFrame(seat, { data: loudSeatPacket(10, 4000) });
  for (let t = 0; t < 4; t++) room.mixerTick(); // onset after 3 hot frames
  assert.equal(room.humanTalk.active, true, "gate engaged");
  assert.equal(room.legs[0].pacer.bufferedFrames, 0, "AI output flushed at onset");
  assert.ok(room.counts.humanBargeIns === 1);

  // while gated: new AI audio is popped-and-dropped, den-voice gets nothing
  emitLegAudio(a, 40);
  await microtask();
  const dvBefore = room.pacer.bufferedFrames;
  await room.onUplinkFrame(seat, { data: loudSeatPacket(6, 4000) });
  for (let t = 0; t < 6; t++) room.mixerTick();
  assert.equal(room.pacer.bufferedFrames, dvBefore, "no AI frames reach den-voice while human talks");
  assert.ok(room.counts.aiFramesDropped > 0, "dropped frames counted");

  // legs still HEAR the human while gated (interruption path stays alive)
  const heard = a.binSent().some((buf) => new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0).getInt16(0, true) !== 0);
  assert.ok(heard, "leg uplink carried the human audio");

  // release: drain remaining seat audio, then 30+ quiet ticks
  for (let t = 0; t < 45; t++) room.mixerTick();
  assert.equal(room.humanTalk.active, false, "gate released after quiet");
});

test("cast den: teardown closes BOTH legs and records LEG-seconds (wall-clock × 2)", async () => {
  let t = 1_000_000;
  const { room, xais, DB } = setupCastDen({ now: () => t });
  const seatId = await joinAndBridge(room);
  t += 60_000; // one minute at the fire
  await room.fetch(post("fireside-voices", "leave", { seatId }));
  assert.equal(room.state, "closed");
  assert.equal(xais[0].closed + xais[1].closed >= 2, true, "both xAI sessions closed");
  assert.equal(DB._tables.voice_usage[0].seconds, 120, "60s wall-clock = 120 leg-seconds");
  const den = DB._tables.voice_usage_den.find((r) => r.den === "fireside-voices");
  assert.equal(den.seconds, 120);
});

test("cast den: assistant transcripts carry the character name; floor-ASR user lines suppressed", async () => {
  const { room, xais } = setupCastDen();
  const seatId = await joinAndBridge(room);
  const got = [];
  room.broadcastControls = (msg) => got.push(msg);
  xais[1].emit("message", { data: JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "oh! no way!" }) });
  xais[0].emit("message", { data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "mixed floor echo" }) });
  await microtask();
  const lines = got.filter((m) => m.type === "transcript");
  assert.equal(lines.length, 1, "user-role floor ASR suppressed on cast dens");
  assert.equal(lines[0].who, "Birch");
  assert.equal(lines[0].role, "assistant");
});

test("cast den: quiet fire rekindles ≤3 times, never while a human holds the floor recently", async () => {
  let t = 1_000_000;
  const { room, xais } = setupCastDen({ now: () => t });
  await joinAndBridge(room);
  emitLegAudio(xais[0], 2);
  await microtask();
  assert.ok(room.legs[0].lastAudioAt > 0);
  const rekindled = () => xais.reduce((n, x) => n + x.jsonSent("response.create").length, 0);
  t += 50_000; // fire quiet 50s
  await room.guardTick();
  assert.equal(rekindled(), 1);
  assert.equal(room.rekindles, 1);
  // recent human floor blocks rekindle
  t += 50_000;
  room.humanTalk.lastActiveAt = t - 1000;
  await room.guardTick();
  assert.equal(rekindled(), 1, "no rekindle while humans recently talked");
  // bound: max 3 per session
  room.humanTalk.lastActiveAt = 0;
  for (let i = 0; i < 6; i++) { t += 50_000; await room.guardTick(); }
  assert.equal(room.rekindles, 3);
  assert.equal(rekindled(), 3);
});

test("cast den: billing error on the SECOND leg still kills the whole fire", async () => {
  const { room, xais, DB } = setupCastDen();
  await joinAndBridge(room);
  xais[1].emit("message", { data: JSON.stringify({ type: "error", error: { message: "insufficient balance" } }) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(room.state, "failed");
  assert.equal(DB._tables.voice_usage.length, 1);
});

test("cast den: warm re-join after close resets the cast (fresh legs, fresh gate)", async () => {
  const { room, xais } = setupCastDen();
  const seatId = await joinAndBridge(room);
  room.counts.humanBargeIns = 5;
  await room.fetch(post("fireside-voices", "leave", { seatId }));
  assert.equal(room.state, "closed");
  await joinAndBridge(room);
  assert.equal(xais.length, 4, "two fresh legs on re-join");
  assert.equal(room.legs.length, 2);
  assert.equal(room.counts.humanBargeIns, 0);
  assert.equal(room.rekindles, 0);
});

test("legacy den unchanged: non-cast slug builds ONE leg-less session (this.legs empty)", async () => {
  const { room, xais } = setupCastDen();
  await joinAndBridge(room, "lobby", { ...joinBody, denName: "The Lobby" });
  assert.equal(xais.length, 1);
  assert.equal(room.legs.length, 0);
  assert.equal(room.guard.pricePerMin, PRICE_PER_MIN_USD);
  const st = room.statusRecord();
  assert.ok(!("cast" in st));
});
