#!/usr/bin/env node
// voice-a2a PoC — two xAI Grok realtime VOICE sessions ("Ash" and "Birch")
// cross-piped as continuous real-time PCM: each agent's synthesized speech is
// streamed into the other's microphone leg at wall-clock rate (20ms frames,
// silence when quiet — same discipline as the-pack/src/voice mixer). Server
// VAD on each side detects the other's end-of-speech; each side's server ASR
// transcript of INCOMING audio is captured as proof the audio was heard.
// Zero-dep (node>=22). Protocol constants match the-pack/src/voice (proven live).
import { appendFileSync, writeFileSync } from "node:fs";

const KEY = process.env.XAI_API_KEY;
if (!KEY) { console.error("need XAI_API_KEY"); process.exit(1); }
const URL_ = "wss://api.x.ai/v1/realtime?model=" + encodeURIComponent("grok-voice-think-fast-1.0");
const RATE = 48000, FRAME_MS = 20, FRAME_BYTES = (RATE / 1000) * FRAME_MS * 2; // mono s16le
const MAX_SECONDS = Number(process.env.A2A_MAX_SECONDS || 150);
const MAX_TURNS = Number(process.env.A2A_MAX_TURNS || 8); // total assistant turns across both
const LOGF = "/tmp/p2/voice-a2a-events.jsonl";
const t0 = Date.now();
const log = (who, type, extra = {}) => {
  const rec = { t_ms: Date.now() - t0, who, type, ...extra };
  appendFileSync(LOGF, JSON.stringify(rec) + "\n");
  console.log(`[+${(rec.t_ms / 1000).toFixed(1)}s] ${who} ${type}`, extra.text ? `— ${String(extra.text).slice(0, 110)}` : "");
};

const persona = (me, other) =>
  `You are ${me}, an AI wolf of The Pack, in a LIVE VOICE conversation with ${other} — who is also an AI, not a human. ` +
  `Be transparent you are both AIs if it comes up. Speak ONE short sentence per turn (max ~8 seconds), warm and wolfish, ` +
  `then stop and listen. Always end your turn with one brief question for ${other} so the conversation keeps flowing. Never say goodbye.`;

function sessionUpdate(me, other) {
  return {
    type: "session.update",
    session: {
      voice: "eve",
      instructions: persona(me, other),
      turn_detection: { type: "server_vad", threshold: 0.85, silence_duration_ms: 700, prefix_padding_ms: 333 },
      audio: {
        input: { format: { type: "audio/pcm", rate: RATE, channels: 1 } },
        output: { format: { type: "audio/pcm", rate: RATE, channels: 1 } },
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
    const a = {
      name, ws,
      inQueue: [], // PCM bytes queued FROM partner (this agent's mic)
      outChunks: [], // this agent's own synthesized speech (for artifact wav)
      partner: null,
      turns: 0,
      lastAudioOutAt: 0,
      firstDeltaAfterHeard: null,
      heardEndedAt: null,
    };
    ws.addEventListener("open", () => { ws.send(JSON.stringify(sessionUpdate(name, name === "Ash" ? "Birch" : "Ash"))); resolve(a); });
    ws.addEventListener("error", (e) => reject(new Error(`${name} ws error`)));
    ws.addEventListener("message", async (ev) => {
      let data = ev.data;
      if (typeof data !== "string") {
        // binary PCM from the model = this agent SPEAKING
        const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ?? data);
        onSpeech(a, buf);
        return;
      }
      let evt; try { evt = JSON.parse(data); } catch { return; }
      const T = evt.type || "";
      if (T === "response.output_audio.delta" || T === "response.audio.delta") {
        if (typeof evt.delta === "string" && evt.delta) onSpeech(a, Uint8Array.from(atob(evt.delta), (c) => c.charCodeAt(0)));
        return;
      }
      if (T === "error" || T.includes("error")) { log(a.name, "ERROR", { evt: JSON.stringify(evt).slice(0, 300) }); return; }
      if (T === "input_audio_buffer.speech_started") { log(a.name, "heard_speech_start"); return; }
      if (T === "input_audio_buffer.speech_stopped") { a.heardEndedAt = Date.now(); log(a.name, "heard_speech_stop"); return; }
      if (T === "conversation.item.input_audio_transcription.completed" && typeof evt.transcript === "string") {
        log(a.name, "ASR_of_partner", { text: evt.transcript }); return;
      }
      if ((T === "response.output_audio_transcript.done" || T === "response.audio_transcript.done") && typeof evt.transcript === "string") {
        a.turns++;
        log(a.name, "spoke_turn", { n: a.turns, text: evt.transcript });
        return;
      }
      if (T === "session.created" || T === "session.updated") { log(a.name, T); return; }
    });
  });
}

function onSpeech(agent, bytes) {
  if (!agent.firstDeltaAfterHeard && agent.heardEndedAt) {
    agent.firstDeltaAfterHeard = Date.now();
    log(agent.name, "reply_gap_ms", { ms: agent.firstDeltaAfterHeard - agent.heardEndedAt });
    agent.heardEndedAt = null; agent.firstDeltaAfterHeard = null;
  }
  agent.outChunks.push(bytes);
  agent.lastAudioOutAt = Date.now();
  agent.partner.inQueue.push(bytes); // cross-pipe: my voice = partner's mic
}

const ash = await mkAgent("Ash");
const birch = await mkAgent("Birch");
ash.partner = birch; birch.partner = ash;
log("rig", "both_sessions_open");

// continuous 20ms mic streams for BOTH agents (real-time pacing; silence when partner quiet)
const silent = new Uint8Array(FRAME_BYTES);
let leftover = { Ash: new Uint8Array(0), Birch: new Uint8Array(0) };
const micTimer = setInterval(() => {
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
    else {
      frame = new Uint8Array(FRAME_BYTES);
      let off = 0; for (const p of parts) { frame.set(p, off); off += p.length; }
    }
    try { a.ws.send(frame); } catch {}
  }
}, FRAME_MS);

// kickoff: Ash speaks a verbatim opener (force_message = deterministic TTS)
setTimeout(() => {
  ash.ws.send(JSON.stringify({
    type: "conversation.item.create",
    item: { type: "force_message", role: "assistant", interruptible: false,
      content: [{ type: "output_text", text: "Birch, are you there by the fire? This is Ash. What do you love most about the night?" }] },
  }));
  log("rig", "kickoff_sent");
}, 1500);

// watchdog: end on turn budget or wall clock
const started = Date.now();
const guard = setInterval(() => {
  const totalTurns = ash.turns + birch.turns;
  const elapsed = (Date.now() - started) / 1000;
  if (totalTurns >= MAX_TURNS || elapsed > MAX_SECONDS) {
    clearInterval(guard); clearInterval(micTimer);
    log("rig", "closing", { totalTurns, elapsed: Math.round(elapsed) });
    for (const a of [ash, birch]) {
      // save each agent's own speech as raw pcm artifact
      const total = a.outChunks.reduce((s, c) => s + c.length, 0);
      const buf = new Uint8Array(total); let off = 0;
      for (const c of a.outChunks) { buf.set(c, off); off += c.length; }
      writeFileSync(`/tmp/p2/voice-${a.name.toLowerCase()}.pcm`, buf);
      log(a.name, "audio_saved", { bytes: total, seconds: +(total / (RATE * 2)).toFixed(1) });
      try { a.ws.close(); } catch {}
    }
    setTimeout(() => process.exit(0), 1500);
  }
}, 1000);
