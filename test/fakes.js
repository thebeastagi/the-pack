// the-pack — hermetic test doubles. Fake D1 dispatches on the exact SQL
// constants from src/db.js (single source of truth for queries), so schema
// drift between code and tests is impossible without touching both.
import { SQL } from "../src/db.js";
import { DenRoom } from "../src/den-room.js";

export function createFakeD1() {
  const t = { users: [], sessions: [], agent_keys: [], dens: [], den_members: [], messages: [], voice_usage: [], voice_flags: [], den_art: [] };
  const clone = (r) => (r ? structuredClone(r) : r);
  const handlers = {
    [SQL.insertUser]: {
      run(a) {
        if (t.users.some((u) => u.handle.toLowerCase() === a[1].toLowerCase())) {
          throw new Error("UNIQUE constraint failed: users.handle");
        }
        t.users.push({ id: a[0], handle: a[1], display_name: a[2], email: a[3], kind: a[4], created_at: a[5], last_seen_at: null });
      },
    },
    [SQL.userByHandle]: { first: (a) => clone(t.users.find((u) => u.handle.toLowerCase() === a[0].toLowerCase())) },
    [SQL.userById]: { first: (a) => clone(t.users.find((u) => u.id === a[0])) },
    [SQL.touchUser]: {
      run(a) {
        const u = t.users.find((x) => x.id === a[1]);
        if (u) u.last_seen_at = a[0];
      },
    },
    [SQL.insertSession]: {
      run(a) {
        t.sessions.push({ id: a[0], user_id: a[1], created_at: a[2], expires_at: a[3], user_agent: a[4] });
      },
    },
    [SQL.sessionById]: { first: (a) => clone(t.sessions.find((s) => s.id === a[0])) },
    [SQL.deleteSession]: {
      run(a) {
        t.sessions = t.sessions.filter((s) => s.id !== a[0]);
      },
    },
    [SQL.insertAgentKey]: {
      run(a) {
        t.agent_keys.push({ id: a[0], user_id: a[1], label: a[2], created_at: a[3], revoked_at: null });
      },
    },
    [SQL.agentKeyById]: { first: (a) => clone(t.agent_keys.find((k) => k.id === a[0] && !k.revoked_at)) },
    [SQL.insertDen]: {
      run(a) {
        if (t.dens.some((d) => d.slug === a[1])) throw new Error("UNIQUE constraint failed: dens.slug");
        t.dens.push({ id: a[0], slug: a[1], name: a[2], topic: a[3], created_by: a[4], created_at: a[5] });
      },
    },
    [SQL.denBySlug]: { first: (a) => clone(t.dens.find((d) => d.slug === a[0])) },
    [SQL.denById]: { first: (a) => clone(t.dens.find((d) => d.id === a[0])) },
    [SQL.listDens]: { all: () => clone(t.dens) },
    [SQL.insertMember]: {
      run(a) {
        if (!t.den_members.some((m) => m.den_id === a[0] && m.user_id === a[1])) {
          t.den_members.push({ den_id: a[0], user_id: a[1], role: a[2], joined_at: a[3] });
        }
      },
    },
    [SQL.memberCount]: { first: (a) => ({ n: t.den_members.filter((m) => m.den_id === a[0]).length }) },
    [SQL.insertMessage]: {
      run(a) {
        t.messages.push({ id: a[0], den_id: a[1], user_id: a[2], body: a[3], created_at: a[4] });
      },
    },
    [SQL.recentMessages]: {
      all(a) {
        return t.messages
          .filter((m) => m.den_id === a[0])
          .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))
          .slice(0, a[1])
          .map((m) => {
            const u = t.users.find((x) => x.id === m.user_id) || {};
            return clone({ id: m.id, body: m.body, created_at: m.created_at, handle: u.handle, display_name: u.display_name, kind: u.kind });
          });
      },
    },
    [SQL.voiceUsageGet]: { first: (a) => clone(t.voice_usage.find((r) => r.day === a[0])) },
    [SQL.voiceUsageAdd]: {
      run(a) {
        const row = t.voice_usage.find((r) => r.day === a[0]);
        if (row) row.seconds += a[1];
        else t.voice_usage.push({ day: a[0], seconds: a[1] });
      },
    },
    [SQL.voiceFlagGet]: { first: (a) => clone(t.voice_flags.find((r) => r.k === a[0])) },
    [SQL.denArtPut]: {
      run(a) {
        const row = t.den_art.find((r) => r.den_id === a[0]);
        const rec = { den_id: a[0], mime: a[1], bytes: a[2], created_at: a[3] };
        if (row) Object.assign(row, rec);
        else t.den_art.push(rec);
      },
    },
    [SQL.denArtGet]: { first: (a) => clone(t.den_art.find((r) => r.den_id === a[0])) },
    [SQL.denSetArtUrl]: {
      run(a) {
        const d = t.dens.find((x) => x.id === a[1]);
        if (d) d.art_url = a[0];
      },
    },
    [SQL.voiceFlagSet]: {
      run(a) {
        const row = t.voice_flags.find((r) => r.k === a[0]);
        if (row) row.v = a[1];
        else t.voice_flags.push({ k: a[0], v: a[1] });
      },
    },
  };

  return {
    _tables: t,
    prepare(sql) {
      const h = handlers[sql];
      if (!h) throw new Error(`fake D1: unhandled SQL: ${sql}`);
      const bound = (args) => ({
        async first() { return h.first ? h.first(args) : null; },
        async all() { return { results: h.all ? h.all(args) : [] }; },
        async run() { if (h.run) h.run(args); return { success: true, meta: { changes: 1 } }; },
      });
      return { bind: (...args) => bound(args), ...bound([]) };
    },
  };
}

// ── fake WebSockets / Durable Object plumbing ────────────────────────────────
function makeFakeSocket() {
  return {
    received: [],   // frames delivered TO this socket
    closed: null,
    _attachment: null,
    _peer: null,
    _listeners: {},
    accept() {},   // non-hibernating accept (VoiceDen adapter/control sockets)
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    emit(type, event) { for (const fn of this._listeners[type] || []) fn(event); },
    send(data) { this._peer ? this._peer.received.push(data) : this.received.push(data); },
    close(code = 1000, reason = "") { this.closed = { code, reason }; },
    serializeAttachment(a) { this._attachment = structuredClone(a); },
    deserializeAttachment() { return this._attachment; },
  };
}

export function installWebSocketStubs() {
  globalThis.WebSocketPair = class {
    constructor() {
      const client = makeFakeSocket();
      const server = makeFakeSocket();
      client._peer = server;
      server._peer = client;
      this[0] = client;
      this[1] = server;
    }
  };
  globalThis.__packUpgradeResponse = (ws) => {
    const r = new Response(null, { status: 200 });
    Object.defineProperty(r, "status", { value: 101 });
    r.webSocket = ws;
    return r;
  };
}

export function makeServerSocket(attachment) {
  const s = makeFakeSocket();
  if (attachment) s.serializeAttachment(attachment);
  return s;
}

export class FakeDurableObjectCtx {
  constructor(id = "fake-do-id") {
    this.id = { toString: () => id };
    this._sockets = [];
    this._waited = [];
  }
  acceptWebSocket(ws) { this._sockets.push(ws); }
  getWebSockets() { return this._sockets.filter((s) => !s.closed); }
  waitUntil(p) { this._waited.push(p); }
}

export function createFakeDoNamespace(env) {
  const rooms = new Map();
  return {
    idFromName(name) { return { toString: () => `name:${name}` }; },
    get(id) {
      const key = id.toString();
      if (!rooms.has(key)) rooms.set(key, new DenRoom(new FakeDurableObjectCtx(key), env));
      const room = rooms.get(key);
      return { fetch: (req) => room.fetch(req instanceof Request ? req : new Request(req)), _room: room };
    },
  };
}

export async function drainMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
