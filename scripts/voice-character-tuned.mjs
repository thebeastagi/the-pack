#!/usr/bin/env node
// voice-character-tuning — two DISTINCT xAI realtime voice characters, cross-piped audio.
// Based on the-pack scripts/voice-a2a-poc.mjs @21d7349 (proven). Changes:
//  - per-agent voice (Ash=lux, Birch=cosmo) + audio.output.speed (Ash 0.8, Birch 1.15)
//  - persona prompts direct pacing / sentence length / tics / register
//  - metrics: chars-per-second of own speech per agent (tests whether speed param is honored)
//  - conversation floor mix recorded real-time (both mic feeds summed) for a back-and-forth clip
import { appendFileSync, writeFileSync } from "node:fs";

const KEY = process.env.XAI_API_KEY;
if (!KEY) { console.error("need XAI_API_KEY"); process.exit(1); }
const URL_ = "wss://api.x.ai/v1/realtime?model=" + encodeURIComponent("grok-voice-think-fast-1.0");
const RATE = 48000, FRAME_MS = 20, FRAME_BYTES = (RATE / 1000) * FRAME_MS * 2;
const MAX_SECONDS = Number(process.env.A2A_MAX_SECONDS || 150);
const MAX_TURNS = Number(process.env.A2A_MAX_TURNS || 8);
const LOGF = "/tmp/vct/events.jsonl";
const t0 = Date.now();
const log = (who, type, extra = {}) => {
  const rec = { t_ms: Date.now() - t0, who, type, ...extra };
  appendFileSync(LOGF, JSON.stringify(rec) + "\n");
  console.log(`[+${(rec.t_ms / 1000).toFixed(1)}s] ${who} ${type}`, extra.text ? `— ${String(extra.text).slice(0, 110)}` : (extra.ms ?? extra.evt ?? ""));
};

const CHARS = {
  Ash: {
    voice: "orion", speed: 0.8, silence_ms: 1100,
    persona:
      "You are Ash, an OLD wolf elder of The Pack, in a LIVE VOICE chat with Birch, a young AI wolf. You are both AIs; be open about that if it comes up. " +
      "CHARACTER RULES, follow strictly: speak SLOWLY, low and gravelly, unhurried, weary. VERY short sentences, three to eight words each; at most two sentences per turn. " +
      "Plain, dry old-timer words; dry wit; a little grumpy but kind. Often open with a slow 'Hm.' or 'Mm.' or a dry 'Heh.' Take your time; pause between sentences. " +
      "NEVER poetic, never flowery, never perform. Talk like a tired old wolf by a dying fire. You do NOT always ask questions; often you just remark and stop. Never say goodbye.",
  },
  Birch: {
    voice: "sirius", speed: 1.15, silence_ms: 1000,
    persona:
      "You are Birch, a YOUNG, quick, endlessly curious AI wolf pup of The Pack, in a LIVE VOICE chat with Ash, an old AI wolf elder. You are both AIs; be open about that if it comes up. " +
      "CHARACTER RULES, follow strictly: talk fast, bright, eager, with playful pup energy. Conversational and natural like an excited kid, NOT performative, no poetry, no purple prose. " +
      "Use casual fillers like 'oh!', 'wait,', 'no way!', 'okay okay'. One or two sentences, then ALWAYS end with one eager question for Ash so he keeps talking. " +
      "You are fascinated by Ash's age and stories. Never say goodbye.",
  },
};

function sessionUpdate(me) {
  const c = CHARS[me];
  return {
    type: "session.update",
    session: {
      voice: c.voice,
      instructions: c.persona,
      turn_detection: { type: "server_vad", threshold: 0.85, silence_duration_ms: c.silence_ms, prefix_padding_ms: 333 },
      audio: {
        input: { format: { type: "audio/pcm", rate: RATE, channels: 1 } },
        output: { format: { type: "audio/pcm", rate: RATE, channels: 1 }, speed: c.speed },
        transport: "binary",
      },
      reasoning: { effort: "high" },
      resumption: { enabled: true },
      idle_timeout_ms: 300000,
    },
  };
}

function mkAgent(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_, { headers: { Authorization: `Bearer ${KEY}` } });
    const a = { name, ws, inQueue: [], outChunks: [], partner: null, turns: 0,
      ownChars: 0, ownBytes: 0, sessionUpdated: false,
      firstDeltaAfterHeard: null, heardEndedAt: null, gaps: [] };
    ws.addEventListener("open", () => { ws.send(JSON.stringify(sessionUpdate(name))); resolve(a); });
    ws.addEventListener("error", () => reject(new Error(`${name} ws error`)));
    ws.addEventListener("message", async (ev) => {
      let data = ev.data;
      if (typeof data !== "string") {
        const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ?? data);
        onSpeech(a, buf); return;
      }
      let evt; try { evt = JSON.parse(data); } catch { return; }
      const T = evt.type || "";
      if (T === "response.output_audio.delta" || T === "response.audio.delta") {
        if (typeof evt.delta === "string" && evt.delta) onSpeech(a, Uint8Array.from(atob(evt.delta), (c) => c.charCodeAt(0)));
        return;
      }
      if (T === "error" || T.includes("error")) { log(a.name, "ERROR", { evt: JSON.stringify(evt).slice(0, 400) }); return; }
      if (T === "input_audio_buffer.speech_started") { log(a.name, "heard_speech_start"); return; }
      if (T === "input_audio_buffer.speech_stopped") { a.heardEndedAt = Date.now(); log(a.name, "heard_speech_stop"); return; }
      if (T === "conversation.item.input_audio_transcription.completed" && typeof evt.transcript === "string") {
        log(a.name, "ASR_of_partner", { text: evt.transcript }); return;
      }
      if ((T === "response.output_audio_transcript.done" || T === "response.audio_transcript.done") && typeof evt.transcript === "string") {
        a.turns++; a.ownChars += evt.transcript.length;
        log(a.name, "spoke_turn", { n: a.turns, text: evt.transcript });
        return;
      }
      if (T === "session.created") { log(a.name, T); return; }
      if (T === "session.updated") { a.sessionUpdated = true; log(a.name, T, { evt: JSON.stringify(evt.session || {}).slice(0, 300) }); return; }
    });
  });
}

function onSpeech(agent, bytes) {
  if (!agent.firstDeltaAfterHeard && agent.heardEndedAt) {
    const ms = Date.now() - agent.heardEndedAt;
    agent.gaps.push(ms);
    log(agent.name, "reply_gap_ms", { ms });
    agent.heardEndedAt = null;
  }
  agent.outChunks.push(bytes);
  agent.ownBytes += bytes.length;
  agent.partner.inQueue.push(bytes);
}

const ash = await mkAgent("Ash");
const birch = await mkAgent("Birch");
ash.partner = birch; birch.partner = ash;
log("rig", "both_sessions_open");

// guard from Jul-23 lesson: invalid session.update silently rejects EVERYTHING — require session.updated
setTimeout(() => {
  for (const a of [ash, birch]) if (!a.sessionUpdated) { log(a.name, "FATAL_no_session_updated"); process.exit(2); }
  log("rig", "both_sessions_updated_ok");
}, 5000);

// conversation floor recording: sum of both agents' mic feeds, real-time paced
const convChunks = [];
const silent = new Uint8Array(FRAME_BYTES);
let leftover = { Ash: new Uint8Array(0), Birch: new Uint8Array(0) };
const micTimer = setInterval(() => {
  const mixFrames = [];
  for (const a of [ash, birch]) {
    let need = FRAME_BYTES;
    const parts = [];
    let lo = leftover[a.name];
    if (lo.length) { parts.push(lo.subarray(0, Math.min(lo.length, need))); need -= parts[0].length; leftover[a.name] = lo.subarray(parts[0].length); }
    while (need > 0 && a.inQueue.length) {
      const c = a.inQueue[0];
      if (c.length <= need) { parts.push(c); need -= c.length; a.inQueue.shift(); }
      else { parts.push(c.subarray(0, need)); leftover[a.name] = c.subarray(need); a.inQueue.shift(); if (leftover[a.name].length) a.inQueue.unshift(leftover[a.name]), leftover[a.name] = new Uint8Array(0); need = 0; }
    }
    let frame;
    if (parts.length === 0) frame = silent;
    else { frame = new Uint8Array(FRAME_BYTES); let off = 0; for (const p of parts) { frame.set(p, off); off += p.length; } }
    try { a.ws.send(frame); } catch {}
    mixFrames.push(frame);
  }
  // mix both mic feeds (saturating s16le add) = full conversation floor
  const mixed = new Int16Array(FRAME_BYTES / 2);
  const fa = new Int16Array(mixFrames[0].buffer, mixFrames[0].byteOffset, FRAME_BYTES / 2);
  const fb = new Int16Array(mixFrames[1].buffer, mixFrames[1].byteOffset, FRAME_BYTES / 2);
  for (let i = 0; i < mixed.length; i++) {
    let s = fa[i] + fb[i];
    mixed[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
  }
  convChunks.push(new Uint8Array(mixed.buffer.slice(0)));
}, FRAME_MS);

// kickoff: Ash opens IN CHARACTER
setTimeout(() => {
  ash.ws.send(JSON.stringify({
    type: "conversation.item.create",
    item: { type: "force_message", role: "assistant", interruptible: false,
      content: [{ type: "output_text", text: "Hm. Birch. You're up late, pup. Something on your mind?" }] },
  }));
  log("rig", "kickoff_sent");
}, 1800);

const started = Date.now();
const guard = setInterval(() => {
  const totalTurns = ash.turns + birch.turns;
  const elapsed = (Date.now() - started) / 1000;
  if (totalTurns >= MAX_TURNS || elapsed > MAX_SECONDS) {
    clearInterval(guard); clearInterval(micTimer);
    log("rig", "closing", { totalTurns, elapsed: Math.round(elapsed) });
    for (const a of [ash, birch]) {
      const total = a.outChunks.reduce((s, c) => s + c.length, 0);
      const buf = new Uint8Array(total); let off = 0;
      for (const c of a.outChunks) { buf.set(c, off); off += c.length; }
      writeFileSync(`/tmp/vct/voice-${a.name.toLowerCase()}.pcm`, buf);
      const secs = total / (RATE * 2);
      log(a.name, "metrics", {
        voice: CHARS[a.name].voice, speed_param: CHARS[a.name].speed,
        audio_seconds: +secs.toFixed(1), transcript_chars: a.ownChars,
        chars_per_sec: +(a.ownChars / secs).toFixed(2), gaps_ms: a.gaps,
      });
      try { a.ws.close(); } catch {}
    }
    const ct = convChunks.reduce((s, c) => s + c.length, 0);
    const cb = new Uint8Array(ct); let co = 0;
    for (const c of convChunks) { cb.set(c, co); co += c.length; }
    writeFileSync(`/tmp/vct/conversation.pcm`, cb);
    log("rig", "conversation_saved", { bytes: ct, seconds: +(ct / (RATE * 2)).toFixed(1) });
    setTimeout(() => process.exit(0), 1500);
  }
}, 1000);
