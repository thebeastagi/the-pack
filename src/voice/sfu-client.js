// the-pack voice — Cloudflare Realtime SFU REST client (verbatim port from
// beast-super-app; B-V1 resolved 2026-07-20).
// Endpoints (base = `${apiBase}/apps/${appId}`, Bearer = app secret):
//   POST /sessions/new                    -> { sessionId }
//   POST /sessions/{id}/tracks/new        -> push (autoDiscover) / pull (remote)
//   POST /adapters/websocket/new          -> ingest (local) / egress (remote)
//   POST /adapters/websocket/close        -> { tracks: [{ adapterId }] }
// 503 + adapter_not_found on close = idempotent success (S5 FOOTGUN).
import { SFU_API_BASE_DEFAULT } from "./config.js";

export class SfuClient {
  constructor(opts) {
    if (!opts.appId) throw new Error("SFU appId is required");
    if (!opts.appSecret) throw new Error("SFU appSecret is required");
    this.base = `${opts.apiBase ?? SFU_API_BASE_DEFAULT}/apps/${opts.appId}`;
    this.secret = opts.appSecret;
    // Never store a bare `fetch` reference — Workers throws "Illegal invocation".
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  headers() {
    return { Authorization: `Bearer ${this.secret}`, "Content-Type": "application/json" };
  }

  async post(path, body) {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }

  async createSession() {
    const { status, text } = await this.post("/sessions/new");
    if (status < 200 || status >= 300) throw new Error(`SFU createSession failed: ${status}`);
    const json = JSON.parse(text);
    if (!json.sessionId) throw new Error("SFU createSession: sessionId missing");
    return json.sessionId;
  }

  /** Browser mic push: autoDiscover the track from the SDP offer. */
  async addTracksAutoDiscover(sessionId, sessionDescription) {
    const { status, text } = await this.post(`/sessions/${sessionId}/tracks/new`, {
      autoDiscover: true,
      sessionDescription,
    });
    if (status < 200 || status >= 300) throw new Error(`SFU addTracksAutoDiscover failed: ${status}`);
    const json = JSON.parse(text);
    const audio = json.tracks?.find((t) => t.kind === "audio" || !t.kind);
    return { audioTrackName: audio?.trackName ?? json.tracks?.[0]?.trackName, json };
  }

  /** Browser pull of a remote track (den-voice) into its session. */
  async pullRemoteTrack(playerSessionId, publisherSessionId, trackName, sessionDescription) {
    return this.pullRemoteTracks(
      playerSessionId,
      [{ sessionId: publisherSessionId, trackName }],
      sessionDescription,
    );
  }

  /** Pull MULTIPLE remote tracks in ONE negotiation (one offer consumed once —
   * the 425 lesson). trackSpecs: [{ sessionId, trackName }]. */
  async pullRemoteTracks(playerSessionId, trackSpecs, sessionDescription) {
    const { status, text } = await this.post(`/sessions/${playerSessionId}/tracks/new`, {
      sessionDescription,
      tracks: trackSpecs.map((t) => ({ location: "remote", sessionId: t.sessionId, trackName: t.trackName, kind: "audio" })),
    });
    if (status < 200 || status >= 300) throw new Error(`SFU pullRemoteTracks failed: ${status}`);
    return JSON.parse(text);
  }

  /** Downlink adapter (DO -> SFU track). mode MUST be "buffer" for local ingest. */
  async createIngestAdapter(trackName, endpoint) {
    const { status, text } = await this.post("/adapters/websocket/new", {
      tracks: [{ location: "local", trackName, endpoint, inputCodec: "pcm", mode: "buffer" }],
    });
    if (status < 200 || status >= 300) throw new Error(`SFU createIngestAdapter failed: ${status}`);
    const json = JSON.parse(text);
    const t = json.tracks?.[0];
    if (!t?.sessionId || !t.adapterId) throw new Error("SFU createIngestAdapter: sessionId/adapterId missing");
    return { sessionId: t.sessionId, adapterId: t.adapterId, trackName: t.trackName ?? trackName };
  }

  /** Uplink adapter (seat mic SFU track -> DO WebSocket). Egress/stream mode. */
  async createEgressAdapter(sessionId, trackName, endpoint) {
    const { status, text } = await this.post("/adapters/websocket/new", {
      tracks: [{ location: "remote", sessionId, trackName, endpoint, outputCodec: "pcm" }],
    });
    if (status < 200 || status >= 300) throw new Error(`SFU createEgressAdapter failed: ${status}`);
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {}
    const adapterId = json.tracks?.[0]?.adapterId;
    console.log("sfu createEgressAdapter:", text.slice(0, 300)); // counts-only diagnostic
    return { adapterId, json };
  }

  /** Idempotent close: 503 adapter_not_found counts as success. */
  async closeAdapter(adapterId) {
    const { status, text } = await this.post("/adapters/websocket/close", {
      tracks: [{ adapterId }],
    });
    if (status >= 200 && status < 300) return { ok: true, alreadyClosed: false, status };
    if (status === 503 && text.includes("adapter_not_found")) return { ok: true, alreadyClosed: true, status };
    return { ok: false, alreadyClosed: false, status };
  }
}
