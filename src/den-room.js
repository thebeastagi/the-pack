// the-pack — DenRoom Durable Object. One instance per den: the coordination
// atom for presence + chat. Hibernating WebSockets; presence = the live socket
// set ONLY (brand rule: the ring is a receipt, not decoration).
import * as db from "./db.js";
import { coerceToText, json, nowIso, uuid } from "./util.js";

const MAX_FRAME_BYTES = 8 * 1024;
const MAX_BODY = 2000;
const RATE_LIMIT = { max: 8, windowMs: 10_000 };

export class DenRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Best-effort per-socket rate buckets. In-memory only; resets on hibernate
    // wake (acceptable — limits are an abuse guard, not a billing control).
    this.buckets = new Map();
  }

  // ── HTTP surface (only reachable via the worker) ─────────────────────────
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/presence" && request.method === "GET") {
      return json({ ok: true, ...this.presencePayload() });
    }

    if (url.pathname === "/internal/broadcast" && request.method === "POST") {
      const frame = await request.json().catch(() => null);
      if (!frame || typeof frame !== "object") return json({ ok: false }, { status: 400 });
      this.broadcast(frame);
      return json({ ok: true, delivered: this.ctx.getWebSockets().length });
    }

    if (url.pathname === "/ws" && request.method === "GET") {
      const identity = {
        userId: request.headers.get("x-pack-user-id") || "",
        handle: request.headers.get("x-pack-handle") || "",
        display: request.headers.get("x-pack-display") || "",
        kind: request.headers.get("x-pack-kind") === "agent" ? "agent" : "human",
      };
      if (!identity.userId || !identity.handle) {
        return json({ ok: false, error: { code: "unauthorized" } }, { status: 401 });
      }
      if (request.headers.get("upgrade") !== "websocket") {
        return json({ ok: false, error: { code: "upgrade_required" } }, { status: 426 });
      }

      const denId = url.searchParams.get("den") || "";
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ ...identity, denId });

      this.broadcast({
        type: "presence",
        action: "join",
        user: { handle: identity.handle, display: identity.display, kind: identity.kind },
        present: this.ctx.getWebSockets().length,
      });
      this.sendJson(server, {
        type: "welcome",
        you: { handle: identity.handle, display: identity.display, kind: identity.kind },
        ...this.presencePayload(),
      });

      // Test hook: Node's Response constructor rejects status 101; CF runtime
      // accepts it. The hook is only ever set by the hermetic test suite.
      const make101 =
        globalThis.__packUpgradeResponse ||
        ((ws) => new Response(null, { status: 101, webSocket: ws }));

      // Joining a den makes you a member (idempotent). Off the hot path.
      if (denId) {
        this.ctx.waitUntil(
          db.addMember(this.env.DB, { denId, userId: identity.userId }).catch(() => {}),
        );
      }
      return make101(client);
    }

    return json({ ok: false, error: { code: "not_found" } }, { status: 404 });
  }

  // ── WebSocket lifecycle (hibernation API) ────────────────────────────────
  async webSocketMessage(ws, raw) {
    const identity = ws.deserializeAttachment() || {};
    const text = await coerceToText(raw); // Blob-safe — NEVER instanceof-gate.
    if (!text || text.length > MAX_FRAME_BYTES) {
      try { ws.close(1009, "frame too large"); } catch {}
      return;
    }
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return this.sendJson(ws, { type: "error", code: "bad_json" });
    }
    if (!frame || typeof frame !== "object") return this.sendJson(ws, { type: "error", code: "bad_frame" });

    if (frame.type === "ping") return this.sendJson(ws, { type: "pong", ts: nowIso() });

    if (frame.type === "chat") {
      if (!this.consumeRate(ws)) return this.sendJson(ws, { type: "error", code: "rate_limited" });
      const body = String(frame.body ?? "").trim().slice(0, MAX_BODY);
      if (!body) return this.sendJson(ws, { type: "error", code: "empty_message" });

      const msg = {
        id: uuid(),
        ts: nowIso(),
        from: { handle: identity.handle, display: identity.display, kind: identity.kind },
        body,
      };
      try {
        await db.createMessage(this.env.DB, { denId: identity.denId, userId: identity.userId, body });
      } catch {
        return this.sendJson(ws, { type: "error", code: "persist_failed" });
      }
      this.broadcast({ type: "chat", ...msg });
      return;
    }

    this.sendJson(ws, { type: "error", code: "unknown_type" });
  }

  async webSocketClose(ws) {
    this.dropSocket(ws);
  }

  async webSocketError(ws) {
    this.dropSocket(ws);
  }

  // ── internals ────────────────────────────────────────────────────────────
  dropSocket(ws) {
    const identity = ws.deserializeAttachment() || {};
    this.buckets.delete(ws);
    try { ws.close(1000); } catch {}
    if (identity.handle) {
      this.broadcast({
        type: "presence",
        action: "leave",
        user: { handle: identity.handle, display: identity.display, kind: identity.kind },
        present: this.roster(ws).length,
      });
    }
  }

  // Deduped by handle (presence is per-identity, not per-tab). `exclude` drops
  // a specific socket still listed by getWebSockets() during close handling.
  roster(exclude = null) {
    const seen = new Map();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      const a = socket.deserializeAttachment() || {};
      if (a.handle && !seen.has(a.handle)) {
        seen.set(a.handle, { handle: a.handle, display: a.display || a.handle, kind: a.kind || "human" });
      }
    }
    return [...seen.values()];
  }

  presencePayload() {
    const roster = this.roster();
    return { present: roster.length, roster };
  }

  consumeRate(ws) {
    const now = Date.now();
    let b = this.buckets.get(ws);
    if (!b || now - b.start > RATE_LIMIT.windowMs) {
      b = { start: now, count: 0 };
      this.buckets.set(ws, b);
    }
    b.count += 1;
    return b.count <= RATE_LIMIT.max;
  }

  sendJson(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  broadcast(obj) {
    const text = JSON.stringify(obj);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(text);
      } catch {}
    }
  }
}
