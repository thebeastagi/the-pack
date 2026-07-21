// the-pack voice — VoiceDen Durable Object. ONE per den: the voice campfire.
//
// Model (campfire, "B-lite"):
//   - ONE xAI realtime session per den (cost = $0.05/min per DEN, not per human)
//   - N seats (humans/agents): each pushes mic via its own SFU session (two-PC
//     pattern: sdp-mic / sdp-listen / media-ready — one negotiation per offer,
//     the Jul-20 425 lesson)
//   - Uplink: per-seat egress adapters stream Packet(48k stereo PCM) -> mono ->
//     per-seat queue -> 20ms MIXER tick (int16 sum + clamp) -> xAI hears everyone
//   - Downlink: xAI -> mono->stereo -> DownlinkPacer (real-time 20ms) -> ingest
//     adapter -> shared SFU track "den-voice" -> every seat's pcListen pulls it
//   - Humans hear the AI; the AI hears all humans. Human↔human audio is P2.5.
//   - Guard: $2/session, 40min, 30min/day (D1), global kill flag (D1),
//     billing/auth xAI error = INSTANT kill. Disclosure FIRST at media-ready.
//
// NO AUDIO IS EVER PERSISTED. State/logging is counts-only.
// FLEET RULE: DO WebSocket binary frames may arrive as Blob — coerceBytes, never
// instanceof-gate (Jul-20 lesson). Non-hibernating sockets: timers must run.
import * as db from "../db.js";
import { randomToken } from "../util.js";
import {
  DAILY_CAP_MINUTES, DEFAULT_XAI_MODEL, DISCLOSURE_TEXT, DOWNLINK_TRACK_NAME, GUARD_TICK_MS, KILLED_TEXT,
  PACER_FRAME_MS, SFU_RATE, SFU_CHANNELS, SFU_WS_CHUNK_BYTES, WRAP_UP_TEXT, XAI_RATE, XAI_CHANNELS, XAI_REALTIME_URL,
} from "./config.js";
import { CostGuard, DailyCap, GuardStatus, KillReason } from "./costguard.js";
import { DownlinkPacer } from "./pacer.js";
import { Chunker, frameBytes, mixMono, monoToStereo, stereoToMono } from "./pcm.js";
import { decodePacket, encodeIngestFrame } from "./packet.js";
import { SfuClient } from "./sfu-client.js";
import {
  buildForceMessage, buildSessionUpdate, classifyError, defaultSessionConfig, extractTranscript, isErrorEvent,
  isSpeechStarted, parseEvent, ErrorKind, TERMINAL_ERROR_KINDS,
} from "./xai-events.js";

/** Node's test runtime hangs on live timers; Workers has no unref. */
function unrefable(t) {
  t?.unref?.();
  return t;
}

const MIX_FRAME_BYTES = frameBytes(XAI_RATE, XAI_CHANNELS, PACER_FRAME_MS); // 1920
const SEAT_QUEUE_CAP_BYTES = XAI_RATE * XAI_CHANNELS * 2 * 2; // 2s per seat
const MAX_SEATS = 8; // bounds O(N²) floor mixing + SFU egress bandwidth
const FLOOR_TRACK_PREFIX = "floor-"; // per-seat "everyone but me" track

/** Production xAI connector: fetch-Upgrade carries Authorization (Workers
 * outbound WS with custom headers). https:// URL form required for upgrades. */
export async function connectXaiWs(url, apiKey) {
  const httpUrl = url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  const resp = await fetch(httpUrl, { headers: { Upgrade: "websocket", Authorization: `Bearer ${apiKey}` } });
  const ws = resp.webSocket;
  if (!ws) throw new Error("xAI WS upgrade failed");
  ws.accept();
  return ws;
}

export class VoiceDen {
  constructor(ctx, env, deps) {
    this.ctx = ctx;
    this.env = env;
    this.deps = deps || {};
    this.state = "created";
    this.adapterToken = "";
    this.denSlug = "";
    this.xai = null;
    this.downlink = null;
    this.guard = null;
    this.pacer = new DownlinkPacer();
    this.downChunker = new Chunker(frameBytes(SFU_RATE, SFU_CHANNELS, PACER_FRAME_MS));
    this.seats = new Map(); // seatId -> seat
    this.ingestAdapterId = null;
    this.ingestSessionId = null;
    this.warnSpoken = false;
    this.disclosurePlayed = false;
    this.pacerTimer = null;
    this.mixerTimer = null;
    this.guardTimer = null;
    this.controls = new Map(); // seatId -> ws
    this.counts = { upBytes: 0, downBytes: 0, xaiEvents: 0, mixTicks: 0 };
    this.sfu = (this.deps.sfuFactory ?? ((id, sec, base) => new SfuClient({ appId: id, appSecret: sec, apiBase: base })))(
      env.REALTIME_SFU_APP_ID,
      env.REALTIME_SFU_SECRET,
      env.SFU_API_BASE,
    );
  }

  now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ---------------------------------------------------------------- routing
  async fetch(request) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/dens\/([a-z0-9][a-z0-9-]{1,39})\/voice\/([a-z-]+)$/);
    if (!m) return json({ error: "not_found" }, 404);
    const [, slug, action] = m;
    this.denSlug = slug;
    try {
      if (action === "join" && request.method === "POST") return await this.handleJoin(request);
      if (action === "sdp-mic" && request.method === "POST") return await this.handleSdpMic(request);
      if (action === "sdp-listen" && request.method === "POST") return await this.handleSdpListen(request);
      if (action === "media-ready" && request.method === "POST") return await this.handleMediaReady(request);
      if (action === "leave" && request.method === "POST") return await this.handleLeave(request);
      if (action === "kill" && request.method === "POST") {
        await this.teardown(KillReason.MANUAL);
        return json({ ok: true });
      }
      if (action === "status") return json(this.statusRecord());
      if (action === "uplink") return this.handleUplinkWs(request, url);
      if (action === "downlink") return this.handleDownlinkWs(request, url);
      if (action === "control") return this.handleControlWs(request, url);
      return json({ error: "not_found" }, 404);
    } catch (err) {
      // Fail-closed: lifecycle errors tear the session down (no half-open spend).
      const detail = String(err instanceof Error ? err.message : err).slice(0, 120);
      console.error("VoiceDen lifecycle error:", detail);
      await this.teardown(KillReason.XAI_ERROR);
      return json({ error: "voice_failed", detail }, 500);
    }
  }

  // ------------------------------------------------------------------- join
  async handleJoin(request) {
    const body = await request.json().catch(() => ({}));
    const handle = String(body.handle || "unknown").slice(0, 24);
    const kind = body.kind === "agent" ? "agent" : "human";
    const denName = String(body.denName || this.denSlug).slice(0, 60);
    const denTopic = String(body.denTopic || "").slice(0, 140);
    if (this.seats.size >= MAX_SEATS) {
      return json({ error: "fire_full", detail: `This fire seats ${MAX_SEATS} — try another den or come back later.` }, 429);
    }

    // A warm DO instance that already closed a session resets and starts fresh.
    if (this.state === "closed" || this.state === "failed") {
      this.state = "created";
      this.guard = null;
      this.pacer = new DownlinkPacer();
      this.downChunker = new Chunker(frameBytes(SFU_RATE, SFU_CHANNELS, PACER_FRAME_MS));
      this.ingestAdapterId = this.ingestSessionId = null;
      this.warnSpoken = this.disclosurePlayed = false;
      this.counts = { upBytes: 0, downBytes: 0, xaiEvents: 0, mixTicks: 0 };
    }
    if (this.state === "created") {
      // Daily cap (authoritative check inside the coordination atom)
      const cap = new DailyCap(DAILY_CAP_MINUTES * 60);
      const used = await db.getVoiceUsage(this.env.DB, cap.key);
      if (!cap.allow(used)) {
        await this.teardown(KillReason.DAILY_CAP);
        return json({ error: "daily_cap_exceeded" }, 429);
      }
      if (await db.getVoiceFlag(this.env.DB, "kill")) {
        await this.teardown(KillReason.MANUAL);
        return json({ error: "kill_switch_active" }, 503);
      }

      this.state = "connecting";
      this.guard = new CostGuard({ startedAt: this.now() });
      this.adapterToken = randomToken(16);

      // 1) xAI connect + configure (disclosure is NOT sent here — it would
      // play into the void before any seat's pcListen exists).
      const connect = this.deps.connectXai ?? connectXaiWs;
      const model = this.env.XAI_MODEL || DEFAULT_XAI_MODEL;
      const apiKey = this.env.XAI_API_KEY;
      try {
        this.xai = await connect(`${XAI_REALTIME_URL}?model=${encodeURIComponent(model)}`, apiKey);
      } finally {
        /* apiKey goes out of scope — never stored */
      }
      this.wireXai(this.xai);
      this.xai.send(JSON.stringify(buildSessionUpdate(defaultSessionConfig(denName, denTopic))));

      // 2) Shared downlink ingest adapter (DO -> SFU track "den-voice")
      const host = this.env.HOSTNAME;
      const downEndpoint = `wss://${host}/api/dens/${this.denSlug}/voice/downlink?token=${this.adapterToken}`;
      const ingest = await this.sfu.createIngestAdapter(DOWNLINK_TRACK_NAME, downEndpoint);
      this.ingestAdapterId = ingest.adapterId;
      this.ingestSessionId = ingest.sessionId;

      this.startTimers();
      this.state = "waiting_media";
    }

    const seatId = randomToken(8);
    // Per-seat "floor" ingest adapter (DO -> SFU track everyone-but-me). A
    // failure here fails THIS seat only — never an already-live session.
    const seat = {
      seatId, handle, kind,
      micSessionId: null, micTrackName: null, egressAdapterId: null,
      uplinkWs: null, queue: [], queueBytes: 0, bytesUp: 0, healed: 0, joinedAt: this.now(),
      floorTrackName: `${FLOOR_TRACK_PREFIX}${seatId}`,
      floorAdapterId: null, floorSessionId: null,
      floorWs: null, floorPacer: new DownlinkPacer(), floorChunker: new Chunker(frameBytes(SFU_RATE, SFU_CHANNELS, PACER_FRAME_MS)),
      floorBytes: 0,
    };
    // Register the seat BEFORE creating its floor adapter: the SFU validates
    // ingest endpoints with a live WS handshake at creation time, and the
    // handler 404s unknown seats (live-observed 2026-07-21: 503 otherwise).
    this.seats.set(seatId, seat);
    try {
      const host = this.env.HOSTNAME;
      const floorEndpoint = `wss://${host}/api/dens/${this.denSlug}/voice/downlink?token=${this.adapterToken}&seat=${seatId}`;
      const floor = await this.sfu.createIngestAdapter(seat.floorTrackName, floorEndpoint);
      seat.floorAdapterId = floor.adapterId;
      seat.floorSessionId = floor.sessionId;
    } catch (err) {
      this.seats.delete(seatId);
      if (this.seats.size === 0 && this.state !== "bridging") throw err; // cold-start: fail-closed
      return json({ error: "seat_floor_failed", detail: String(err?.message || err).slice(0, 80) }, 500);
    }
    this.broadcastControls({ type: "seats", seats: this.seatList() });
    const base = `/api/dens/${this.denSlug}/voice`;
    return json({
      ok: true,
      seatId,
      state: this.state,
      urls: {
        sdpMic: `${base}/sdp-mic`,
        sdpListen: `${base}/sdp-listen`,
        mediaReady: `${base}/media-ready`,
        leave: `${base}/leave`,
        control: `${base}/control?seat=${seatId}`,
      },
    });
  }

  // ------------------------------------------------- sdp (two-PC pattern)
  async readOffer(request) {
    const body = await request.json().catch(() => ({}));
    return body.offer?.sdp && body.offer?.type ? body.offer : null;
  }

  async handleSdpMic(request) {
    if (this.state !== "waiting_media" && this.state !== "bridging") return json({ error: "bad_state", state: this.state }, 409);
    const body = await request.json().catch(() => ({}));
    const seat = this.seats.get(String(body.seatId || ""));
    if (!seat) return json({ error: "unknown_seat" }, 404);
    if (!body.offer?.sdp) return json({ error: "offer_required" }, 400);

    try {
      seat.micSessionId = await this.sfu.createSession();
      const discovered = await this.sfu.addTracksAutoDiscover(seat.micSessionId, body.offer);
      seat.micTrackName = discovered.audioTrackName ?? null;
      if (!seat.micTrackName) throw new Error("SFU: no audio track discovered in mic offer");
      const answer = discovered.json?.sessionDescription;
      if (!answer) throw new Error("SFU: no sessionDescription in tracks/new response");
      return json({ answer });
    } catch (err) {
      // A seat's failure must never kill a live session (P2.5 multi-human).
      await this.dropSeat(seat.seatId, KillReason.ADAPTER_LOST);
      return json({ error: "seat_failed", detail: String(err?.message || err).slice(0, 80) }, 500);
    }
  }

  async handleSdpListen(request) {
    if (this.state !== "waiting_media" && this.state !== "bridging") return json({ error: "bad_state", state: this.state }, 409);
    const body = await request.json().catch(() => ({}));
    const seat = this.seats.get(String(body.seatId || ""));
    if (!seat) return json({ error: "unknown_seat" }, 404);
    if (!body.offer?.sdp) return json({ error: "offer_required" }, 400);
    if (!this.ingestSessionId || !seat.floorSessionId) throw new Error("no downlink session");

    const listenerSessionId = await this.sfu.createSession();
    let answer = null, lastErr = null;
    // ONE negotiation pulls BOTH tracks: den-voice (the AI) + this seat's
    // floor (everyone-but-me, mixed in the DO). 425 "Too Early" race: retry.
    const trackSpecs = [
      { sessionId: this.ingestSessionId, trackName: DOWNLINK_TRACK_NAME },
      { sessionId: seat.floorSessionId, trackName: seat.floorTrackName },
    ];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        answer = await this.sfu.pullRemoteTracks(listenerSessionId, trackSpecs, body.offer);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!String(err instanceof Error ? err.message : err).includes("425")) throw err;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (lastErr) {
      await this.dropSeat(seat.seatId, KillReason.ADAPTER_LOST);
      return json({ error: "seat_failed", detail: String(lastErr?.message || lastErr).slice(0, 80) }, 500);
    }
    const sessionDescription = answer?.sessionDescription;
    if (!sessionDescription) {
      await this.dropSeat(seat.seatId, KillReason.ADAPTER_LOST);
      return json({ error: "seat_failed", detail: "no sessionDescription in pull response" }, 500);
    }
    return json({ answer: sessionDescription });
  }

  async handleMediaReady(request) {
    if (this.state !== "waiting_media" && this.state !== "bridging") return json({ error: "bad_state", state: this.state }, 409);
    const body = await request.json().catch(() => ({}));
    const seat = this.seats.get(String(body.seatId || ""));
    if (!seat) return json({ error: "unknown_seat" }, 404);
    if (!seat.micSessionId || !seat.micTrackName) return json({ error: "mic_not_negotiated" }, 409);

    // Mic media is flowing — register this seat's uplink egress adapter.
    const host = this.env.HOSTNAME;
    const upEndpoint = `wss://${host}/api/dens/${this.denSlug}/voice/uplink?token=${this.adapterToken}&seat=${seat.seatId}`;
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const egress = await this.sfu.createEgressAdapter(seat.micSessionId, seat.micTrackName, upEndpoint);
        seat.egressAdapterId = egress.adapterId ?? null;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (lastErr) {
      await this.dropSeat(seat.seatId, KillReason.ADAPTER_LOST);
      return json({ error: "seat_failed", detail: String(lastErr?.message || lastErr).slice(0, 80) }, 500);
    }

    // Self-heal keyed on FRAMES (bytesUp), not attach — an adapter registered
    // before mic media flows can attach-but-never-stream (live-observed).
    const heal = () => {
      if ((this.state !== "bridging" && this.state !== "waiting_media") || seat.bytesUp > 0 || seat.healed >= 2) return;
      if (!this.seats.has(seat.seatId)) return;
      seat.healed++;
      void (async () => {
        try {
          if (seat.egressAdapterId) await this.sfu.closeAdapter(seat.egressAdapterId);
          try { seat.uplinkWs?.close(1000, "stale adapter replaced"); } catch {}
          seat.uplinkWs = null;
          const retry = await this.sfu.createEgressAdapter(seat.micSessionId, seat.micTrackName, upEndpoint);
          seat.egressAdapterId = retry.adapterId ?? null;
          console.log(`uplink: self-heal re-registered seat ${seat.handle} (attempt ${seat.healed})`);
        } catch {}
        unrefable(setTimeout(heal, 8000));
      })();
    };
    unrefable(setTimeout(heal, 8000));

    // Disclosure plays when the FIRST seat can actually hear it.
    if (!this.disclosurePlayed) {
      this.disclosurePlayed = true;
      try {
        this.xai?.send(JSON.stringify(buildForceMessage(DISCLOSURE_TEXT, false)));
      } catch {}
    }

    this.state = "bridging";
    this.broadcastControls({ type: "state", state: this.state });
    return json({ ok: true, state: this.state });
  }

  async handleLeave(request) {
    const body = await request.json().catch(() => ({}));
    await this.dropSeat(String(body.seatId || ""), KillReason.HANGUP);
    return json({ ok: true, seats: this.seats.size });
  }

  async dropSeat(seatId, reason) {
    const seat = this.seats.get(seatId);
    if (!seat) return;
    this.seats.delete(seatId);
    for (const id of [seat.egressAdapterId, seat.floorAdapterId]) {
      if (!id) continue;
      try { await this.sfu.closeAdapter(id); } catch {}
    }
    try { seat.uplinkWs?.close(1000, "seat left"); } catch {}
    try { seat.floorWs?.close(1000, "seat left"); } catch {}
    const ctl = this.controls.get(seatId);
    if (ctl) {
      this.sendControl(ctl, { type: "ended", reason });
      try { ctl.close(1000, "left voice"); } catch {}
      this.controls.delete(seatId);
    }
    this.broadcastControls({ type: "seats", seats: this.seatList() });
    // Last seat gone -> close the fireside (stops all xAI spend).
    if (this.seats.size === 0 && (this.state === "bridging" || this.state === "waiting_media")) {
      await this.teardown(KillReason.HANGUP);
    }
  }

  // ------------------------------------------------------- adapter sockets
  upgrade(client) {
    if (this.deps.upgradeResponse) return this.deps.upgradeResponse(client);
    return new Response(null, { status: 101, webSocket: client });
  }

  tokenOk(url) {
    return this.adapterToken && url.searchParams.get("token") === this.adapterToken;
  }

  handleUplinkWs(request, url) {
    // Token-authenticated (the SFU is the only party with this URL).
    if (!this.tokenOk(url)) return new Response("forbidden", { status: 403 });
    const seat = this.seats.get(String(url.searchParams.get("seat") || ""));
    if (!seat) return new Response("unknown seat", { status: 404 });
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept(); // non-hibernating: keeps timers alive
    console.log(`uplink: SFU attached for seat ${seat.handle}`);
    try { seat.uplinkWs?.close(1000, "superseded"); } catch {}
    seat.uplinkWs = server;
    server.addEventListener("message", (e) => this.onUplinkFrame(seat, e));
    server.addEventListener("close", () => {
      if (seat.uplinkWs === server) seat.uplinkWs = null;
    });
    server.addEventListener("error", () => {
      if (seat.uplinkWs === server) seat.uplinkWs = null;
    });
    return this.upgrade(pair[0]);
  }

  handleDownlinkWs(request, url) {
    if (!this.tokenOk(url)) return new Response("forbidden", { status: 403 });
    // ?seat= routes the socket to that seat's floor stream; bare = shared AI voice.
    const seatId = url.searchParams.get("seat");
    const seat = seatId ? this.seats.get(seatId) : null;
    if (seatId && !seat) return new Response("unknown seat", { status: 404 });
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    if (seat) {
      try { seat.floorWs?.close(1000, "superseded"); } catch {}
      seat.floorWs = server;
      server.addEventListener("close", () => {
        if (seat.floorWs === server) seat.floorWs = null;
      });
      server.addEventListener("error", () => {
        if (seat.floorWs === server) seat.floorWs = null;
      });
    } else {
      try { this.downlink?.close(1000, "superseded"); } catch {}
      this.downlink = server;
      server.addEventListener("close", () => {
        if (this.downlink === server) this.downlink = null;
      });
      server.addEventListener("error", () => {
        if (this.downlink === server) this.downlink = null;
      });
    }
    return this.upgrade(pair[0]);
  }

  onUplinkFrame(seat, event) {
    if (this.state !== "bridging" && this.state !== "waiting_media") return;
    // Returned so tests can await deterministically; production ignores it.
    return coerceBytes(event?.data)
      .then((data) => {
        if (!data) return;
        try {
          const pkt = decodePacket(data);
          if (pkt.payload.length === 0) return; // end-of-stream marker
          const mono = stereoToMono(pkt.payload);
          seat.queue.push(mono);
          seat.queueBytes += mono.length;
          seat.bytesUp += mono.length;
          this.counts.upBytes += mono.length;
          // Bound the per-seat queue (drop oldest — fresher audio wins).
          while (seat.queueBytes > SEAT_QUEUE_CAP_BYTES && seat.queue.length > 1) {
            seat.queueBytes -= seat.queue.shift().length;
          }
        } catch {
          /* malformed adapter frame: drop, never crash the session */
        }
      })
      .catch(() => {});
  }

  // ------------------------------------------------------------- xAI wiring
  pushAssistantAudio(mono) {
    this.counts.downBytes += mono.length;
    const stereo = monoToStereo(mono);
    for (const frame of this.downChunker.feed(stereo)) this.pacer.push(frame);
  }

  wireXai(ws) {
    ws.addEventListener("message", (e) => this.onXaiMessage(e));
    const onGone = () => {
      if (this.state === "bridging" || this.state === "waiting_media") void this.teardown(KillReason.XAI_ERROR);
    };
    ws.addEventListener("close", onGone);
    ws.addEventListener("error", onGone);
  }

  async onXaiMessage(event) {
    const data = event?.data;
    const binAudio = await coerceBytes(data);
    if (binAudio) {
      this.pushAssistantAudio(binAudio);
      return;
    }
    if (typeof data !== "string") return;
    let evt;
    try {
      evt = parseEvent(data);
    } catch {
      return;
    }
    this.counts.xaiEvents++;

    // JSON base64 audio deltas (server may deliver these despite binary transport)
    if (evt.type === "response.output_audio.delta" || evt.type === "response.audio.delta") {
      const b64 = typeof evt.delta === "string" ? evt.delta : "";
      if (b64) this.pushAssistantAudio(base64ToU8(b64));
      return;
    }
    if (isErrorEvent(evt)) {
      const kind = classifyError(evt);
      if (TERMINAL_ERROR_KINDS.has(kind)) {
        await this.teardown(kind === ErrorKind.BILLING ? KillReason.BILLING_ERROR : KillReason.AUTH_ERROR);
      }
      return;
    }
    if (isSpeechStarted(evt)) {
      this.pacer.flush(); // barge-in
      return;
    }
    const line = extractTranscript(evt);
    if (line) this.broadcastControls({ type: "transcript", ...line });
  }

  // ---------------------------------------------------------- control channel
  handleControlWs(request, url) {
    const seatId = String(url.searchParams.get("seat") || "");
    if (!this.seats.has(seatId)) return new Response("unknown seat", { status: 404 });
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    try { this.controls.get(seatId)?.close(1000, "superseded"); } catch {}
    this.controls.set(seatId, server);
    server.addEventListener("message", (e) => {
      const data = e?.data;
      if (typeof data !== "string") return;
      try {
        const msg = JSON.parse(data);
        if (msg.type === "leave") void this.dropSeat(seatId, KillReason.HANGUP);
      } catch {}
    });
    server.addEventListener("close", () => {
      if (this.controls.get(seatId) === server) this.controls.delete(seatId);
      // Browser gone mid-voice => the seat leaves (no orphaned spend).
      void this.dropSeat(seatId, KillReason.HANGUP);
    });
    this.sendControl(server, { type: "state", state: this.state });
    this.sendControl(server, { type: "seats", seats: this.seatList() });
    return this.upgrade(pair[0]);
  }

  sendControl(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  broadcastControls(msg) {
    for (const ws of this.controls.values()) this.sendControl(ws, msg);
  }

  seatList() {
    return [...this.seats.values()].map((s) => ({ handle: s.handle, kind: s.kind, speaking: s.bytesUp > 0 }));
  }

  // ----------------------------------------------------------------- timers
  startTimers() {
    // Downlink pacers: exact real-time 20ms cadence into the SFU ingest
    // adapters — the shared AI voice + each seat's floor (everyone-but-me).
    this.pacerTimer = unrefable(setInterval(() => {
      if (this.downlink) {
        const frame = this.pacer.pop();
        if (frame) {
          const pkt = encodeIngestFrame(frame);
          if (pkt.length <= SFU_WS_CHUNK_BYTES) {
            try { this.downlink.send(pkt); } catch {}
          }
        }
      }
      for (const seat of this.seats.values()) {
        if (!seat.floorWs) continue; // hold until the SFU attaches
        const frame = seat.floorPacer.pop();
        if (!frame) continue;
        const pkt = encodeIngestFrame(frame);
        if (pkt.length <= SFU_WS_CHUNK_BYTES) {
          try {
            seat.floorWs.send(pkt);
            seat.floorBytes += frame.length;
          } catch {}
        }
      }
    }, PACER_FRAME_MS));

    // Unified mixer tick: take each seat's 20ms frame ONCE, then fan out:
    // (a) xAI hears EVERYONE (single mixed mono stream);
    // (b) each seat's floor hears everyone BUT that seat (human↔human audio).
    this.mixerTimer = unrefable(setInterval(() => {
      if (this.state !== "bridging") return;
      this.counts.mixTicks++;
      const frames = new Map(); // seatId -> Uint8Array | null
      let anyAudio = false;
      for (const seat of this.seats.values()) {
        const take = this.takeFromSeat(seat, MIX_FRAME_BYTES);
        frames.set(seat.seatId, take);
        if (take) anyAudio = true;
      }
      // (a) xAI leg (unchanged behavior; continuous stream incl. silence)
      if (this.xai) {
        const mixed = anyAudio ? mixMono([...frames.values()], MIX_FRAME_BYTES) : new Uint8Array(MIX_FRAME_BYTES);
        try {
          this.xai.send(mixed);
        } catch {}
      }
      // (b) floor legs (only when someone else actually spoke — silence otherwise)
      for (const dest of this.seats.values()) {
        const parts = [];
        let heard = false;
        for (const [srcId, frame] of frames) {
          if (srcId === dest.seatId) continue;
          parts.push(frame);
          if (frame) heard = true;
        }
        if (!heard) continue;
        const mono = mixMono(parts, MIX_FRAME_BYTES);
        const stereo = monoToStereo(mono);
        for (const chunk of dest.floorChunker.feed(stereo)) dest.floorPacer.push(chunk);
      }
    }, PACER_FRAME_MS));

    this.guardTimer = unrefable(setInterval(() => {
      void this.guardTick();
    }, GUARD_TICK_MS));
  }

  /** Take up to `n` bytes from a seat queue; null when the seat is silent. */
  takeFromSeat(seat, n) {
    if (seat.queueBytes === 0) return null;
    const out = new Uint8Array(Math.min(n, seat.queueBytes));
    let pos = 0;
    while (pos < out.length && seat.queue.length) {
      const head = seat.queue[0];
      const need = out.length - pos;
      if (head.length <= need) {
        out.set(head, pos);
        pos += head.length;
        seat.queueBytes -= head.length;
        seat.queue.shift();
      } else {
        out.set(head.slice(0, need), pos);
        seat.queue[0] = head.slice(need);
        seat.queueBytes -= need;
        pos += need;
      }
    }
    return out;
  }

  async guardTick() {
    if (!this.guard || this.state === "closing" || this.state === "closed") return;
    // Idle guard: nobody reached media within 2 min of session start (mic
    // permission denied / abandoned tab) -> close; never burn idle spend.
    if (this.state === "waiting_media" && this.guard.elapsedS(this.now()) > 120) {
      await this.teardown(KillReason.IDLE_TIMEOUT);
      return;
    }
    if (await db.getVoiceFlag(this.env.DB, "kill")) {
      await this.teardown(KillReason.MANUAL);
      return;
    }
    const st = this.guard.status(this.now());
    if (st === GuardStatus.WARN && !this.warnSpoken) {
      this.warnSpoken = true;
      try {
        this.xai?.send(JSON.stringify(buildForceMessage(WRAP_UP_TEXT, true)));
      } catch {}
      this.broadcastControls({ type: "warn" });
    }
    if (st === GuardStatus.KILL) {
      await this.teardown(this.guard.killReason);
      return;
    }
    this.broadcastControls({ type: "status", ...this.statusRecord() });
  }

  // --------------------------------------------------------------- teardown
  async teardown(reason) {
    if (this.state === "closing" || this.state === "closed" || this.state === "failed") return;
    this.state = "closing";
    this.guard?.kill(reason);
    if (this.pacerTimer) clearInterval(this.pacerTimer);
    if (this.mixerTimer) clearInterval(this.mixerTimer);
    if (this.guardTimer) clearInterval(this.guardTimer);
    this.pacer.flush();

    if (reason === KillReason.BUDGET_EXCEEDED || reason === KillReason.MAX_DURATION) {
      try {
        this.xai?.send(JSON.stringify(buildForceMessage(KILLED_TEXT, false)));
      } catch {}
    }

    const adapterIds = [
      this.ingestAdapterId,
      ...[...this.seats.values()].flatMap((s) => [s.egressAdapterId, s.floorAdapterId]),
    ].filter(Boolean);
    for (const id of adapterIds) {
      try {
        await this.sfu.closeAdapter(id);
      } catch {}
    }
    try { this.xai?.close(1000, "voice den closed"); } catch {}
    try { this.downlink?.close(1000, "voice den closed"); } catch {}
    for (const seat of this.seats.values()) {
      try { seat.uplinkWs?.close(1000, "voice den closed"); } catch {}
      try { seat.floorWs?.close(1000, "voice den closed"); } catch {}
    }
    this.xai = this.downlink = null;

    // Daily-cap accounting (counts-only, D1)
    if (this.guard) {
      const cap = new DailyCap(DAILY_CAP_MINUTES * 60);
      const elapsed = Math.round(this.guard.elapsedS(this.now()));
      try {
        await db.addVoiceUsage(this.env.DB, cap.key, elapsed);
      } catch {}
    }

    const FAILED = new Set([KillReason.XAI_ERROR, KillReason.BILLING_ERROR, KillReason.AUTH_ERROR, KillReason.ADAPTER_LOST]);
    this.state = FAILED.has(reason) ? "failed" : "closed";
    this.broadcastControls({ type: "ended", reason });
    for (const ws of this.controls.values()) {
      try { ws.close(1000, "voice den closed"); } catch {}
    }
    this.controls.clear();
    this.seats.clear();
  }

  statusRecord() {
    let floorBytes = 0;
    for (const s of this.seats.values()) floorBytes += s.floorBytes;
    return {
      state: this.state,
      seats: this.seats.size,
      elapsedS: this.guard ? Math.round(this.guard.elapsedS(this.now()) * 10) / 10 : 0,
      estCostUsd: this.guard ? Math.round(this.guard.estimateCostUsd(this.now()) * 10000) / 10000 : 0,
      killReason: this.guard?.killReason ?? KillReason.NONE,
      bufferedMs: this.pacer.bufferedMs,
      counts: { ...this.counts, floorBytes, pacer: { ...this.pacer.stats } },
    };
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Coerce any WS binary frame payload to bytes. Live-observed 2026-07-20:
 * DO-accepted WebSockets deliver binary frames as **Blob**, NOT ArrayBuffer —
 * plain instanceof checks silently dropped every frame. NEVER instanceof-gate. */
async function coerceBytes(d) {
  if (d == null || typeof d === "string") return null;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (typeof Blob !== "undefined" && d instanceof Blob) return new Uint8Array(await d.arrayBuffer());
  if (typeof d === "object" && Object.prototype.toString.call(d) === "[object ArrayBuffer]") {
    return new Uint8Array(d);
  }
  return null;
}

function base64ToU8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
