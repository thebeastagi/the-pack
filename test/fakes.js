// the-pack — hermetic test doubles. Fake D1 dispatches on the exact SQL
// constants from src/db.js (single source of truth for queries), so schema
// drift between code and tests is impossible without touching both.
import { SQL } from "../src/db.js";
import { DenRoom } from "../src/den-room.js";

export function createFakeD1() {
  const t = {
    users: [], sessions: [], agent_keys: [], dens: [], den_members: [], messages: [],
    voice_usage: [], voice_flags: [], brain_usage: [], den_collections: [], den_docs: [], voice_usage_den: [],
    credit_balances: [], credit_ledger: [], payment_orders: [],
    auth_challenges: [], dev_outbox: [],
  };
  const clone = (r) => (r ? structuredClone(r) : r);
  const handlers = {
    [SQL.insertUser]: {
      run(a) {
        if (t.users.some((u) => u.handle.toLowerCase() === a[1].toLowerCase())) {
          throw new Error("UNIQUE constraint failed: users.handle");
        }
        // 0009 partial unique index: one VERIFIED email per account.
        if (a[4] && a[3] && t.users.some((u) => u.email_verified_at && u.email && u.email.toLowerCase() === a[3].toLowerCase())) {
          throw new Error("UNIQUE constraint failed: idx_users_verified_email");
        }
        t.users.push({ id: a[0], handle: a[1], display_name: a[2], email: a[3], email_verified_at: a[4], kind: a[5], created_at: a[6], last_seen_at: null });
      },
    },
    [SQL.userByHandle]: { first: (a) => clone(t.users.find((u) => u.handle.toLowerCase() === a[0].toLowerCase())) },
    [SQL.userById]: { first: (a) => clone(t.users.find((u) => u.id === a[0])) },
    [SQL.userByVerifiedEmail]: {
      first: (a) => clone(t.users.find((u) => u.email && u.email.toLowerCase() === a[0].toLowerCase() && u.email_verified_at)),
    },
    [SQL.legacyUserByEmail]: {
      first: (a) =>
        clone(
          t.users
            .filter((u) => u.email && u.email.toLowerCase() === a[0].toLowerCase() && !u.email_verified_at && u.kind === "human" && u.created_at < a[1])
            .sort((x, y) => (x.created_at < y.created_at ? -1 : 1))[0],
        ),
    },
    [SQL.bindVerifiedEmail]: {
      run(a) {
        const u = t.users.find((x) => x.id === a[2]);
        if (u) {
          if (t.users.some((o) => o.id !== u.id && o.email_verified_at && o.email && o.email.toLowerCase() === a[0].toLowerCase())) {
            throw new Error("UNIQUE constraint failed: idx_users_verified_email");
          }
          u.email = a[0];
          u.email_verified_at = a[1];
        }
      },
    },
    // ── native email-OTP auth (0010) ────────────────────────────────────
    [SQL.authChallengeInsert]: {
      run(a) {
        t.auth_challenges.push({
          id: a[0], kind: a[1], email: a[2], code_hash: a[3], ip: a[4],
          attempts: 0, created_at: a[5], expires_at: a[6], consumed_at: null,
        });
      },
    },
    [SQL.authChallengeActiveByEmail]: {
      first: (a) =>
        clone(
          t.auth_challenges
            .filter((c) => c.kind === a[0] && c.email.toLowerCase() === a[1].toLowerCase() && !c.consumed_at)
            .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))[0],
        ),
    },
    [SQL.authChallengeById]: { first: (a) => clone(t.auth_challenges.find((c) => c.id === a[0])) },
    [SQL.authChallengeBumpAttempts]: {
      run(a) {
        const c = t.auth_challenges.find((x) => x.id === a[0]);
        if (c) c.attempts += 1;
      },
    },
    [SQL.authChallengeConsume]: {
      run(a) {
        const c = t.auth_challenges.find((x) => x.id === a[1] && !x.consumed_at);
        if (!c) return { changes: 0 }; // the one-time gate
        c.consumed_at = a[0];
        return { changes: 1 };
      },
    },
    [SQL.authChallengeInvalidate]: {
      run(a) {
        let n = 0;
        for (const c of t.auth_challenges) {
          if (c.kind === a[1] && c.email.toLowerCase() === a[2].toLowerCase() && !c.consumed_at) {
            c.consumed_at = a[0];
            n++;
          }
        }
        return { changes: n };
      },
    },
    [SQL.authSendsByEmailSince]: {
      first: (a) => ({ n: t.auth_challenges.filter((c) => c.kind === "otp" && c.email.toLowerCase() === a[0].toLowerCase() && c.created_at >= a[1]).length }),
    },
    [SQL.authSendsByIpSince]: {
      first: (a) => ({ n: t.auth_challenges.filter((c) => c.kind === "otp" && c.ip === a[0] && c.created_at >= a[1]).length }),
    },
    [SQL.authSendsGlobalSince]: {
      first: (a) => ({ n: t.auth_challenges.filter((c) => c.kind === "otp" && c.created_at >= a[0]).length }),
    },
    [SQL.devMailInsert]: {
      run(a) {
        t.dev_outbox.push({ id: a[0], email: a[1], subject: a[2], body: a[3], created_at: a[4] });
      },
    },
    [SQL.devMailByEmail]: {
      all: (a) =>
        t.dev_outbox
          .filter((m) => m.email.toLowerCase() === a[0].toLowerCase())
          .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))
          .slice(0, 5)
          .map(clone),
    },
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
        t.dens.push({ id: a[0], slug: a[1], name: a[2], topic: a[3], brain_tier: a[4], search_tools: a[5], created_by: a[6], created_at: a[7] });
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
    [SQL.agentUsers]: { all: () => clone(t.users.filter((u) => u.kind === "agent")) },
    [SQL.voiceUsageGet]: { first: (a) => clone(t.voice_usage.find((r) => r.day === a[0])) },
    [SQL.voiceUsageAdd]: {
      run(a) {
        const row = t.voice_usage.find((r) => r.day === a[0]);
        if (row) row.seconds += a[1];
        else t.voice_usage.push({ day: a[0], seconds: a[1] });
      },
    },
    [SQL.voiceFlagGet]: { first: (a) => clone(t.voice_flags.find((r) => r.k === a[0])) },
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
    [SQL.brainUsageGet]: {
      first: (a) => clone(t.brain_usage.find((r) => r.day === a[0] && r.den === a[1] && r.kind === a[2]) || null),
    },
    [SQL.brainUsageGlobalTicks]: {
      first: (a) => ({
        ticks: t.brain_usage.filter((r) => r.day === a[0] && r.den === "*").reduce((s, r) => s + r.ticks, 0),
      }),
    },
    [SQL.brainUsageAdd]: {
      run(a) {
        const row = t.brain_usage.find((r) => r.day === a[0] && r.den === a[1] && r.kind === a[2]);
        if (row) {
          row.calls += a[3];
          row.ticks += a[4];
        } else {
          t.brain_usage.push({ day: a[0], den: a[1], kind: a[2], calls: a[3], ticks: a[4] });
        }
      },
    },
    [SQL.brainUsageDay]: {
      all: (a) => clone(t.brain_usage.filter((r) => r.day === a[0])),
    },
    [SQL.denCollectionGet]: { first: (a) => clone(t.den_collections.find((r) => r.den_id === a[0]) || null) },
    [SQL.denCollectionInsert]: {
      run(a) {
        t.den_collections.push({ den_id: a[0], collection_id: a[1], created_at: a[2] });
      },
    },
    [SQL.denDocInsert]: {
      run(a) {
        t.den_docs.push({ id: a[0], den_id: a[1], file_id: a[2], name: a[3], bytes: a[4], status: a[5], added_by: a[6], created_at: a[7] });
      },
    },
    [SQL.denDocsByDen]: { all: (a) => clone(t.den_docs.filter((d) => d.den_id === a[0])) },
    [SQL.denDocById]: { first: (a) => clone(t.den_docs.find((d) => d.id === a[0] && d.den_id === a[1]) || null) },
    [SQL.denDocSetStatus]: {
      run(a) {
        const d = t.den_docs.find((x) => x.id === a[1]);
        if (d) d.status = a[0];
      },
    },
    [SQL.denDocDelete]: {
      run(a) {
        t.den_docs = t.den_docs.filter((d) => d.id !== a[0]);
      },
    },
    [SQL.denDocsCount]: { first: (a) => ({ n: t.den_docs.filter((d) => d.den_id === a[0]).length }) },
    [SQL.denDocsReadyCount]: { first: (a) => ({ n: t.den_docs.filter((d) => d.den_id === a[0] && d.status === "ready").length }) },
    [SQL.voiceUsageDenGet]: { first: (a) => clone(t.voice_usage_den.find((r) => r.day === a[0] && r.den === a[1]) || null) },
    [SQL.voiceUsageDenAdd]: {
      run(a) {
        const row = t.voice_usage_den.find((r) => r.day === a[0] && r.den === a[1]);
        if (row) row.seconds += a[2];
        else t.voice_usage_den.push({ day: a[0], den: a[1], seconds: a[2] });
      },
    },

    // ── credits + payments (migration 0008) ────────────────────────────────
    [SQL.creditBalanceGet]: {
      first: (a) => clone(t.credit_balances.find((r) => r.user_id === a[0]) || null),
    },
    [SQL.creditDebit]: {
      run(a) {
        const row = t.credit_balances.find((r) => r.user_id === a[1]);
        if (!row || row.balance < a[0]) return { changes: 0 }; // the money gate
        row.balance -= a[0];
        return { changes: 1 };
      },
    },
    [SQL.creditGrant]: {
      run(a) {
        const row = t.credit_balances.find((r) => r.user_id === a[0]);
        if (row) row.balance += a[1];
        else t.credit_balances.push({ user_id: a[0], balance: a[1] });
        return { changes: 1 };
      },
    },
    [SQL.creditLedgerInsert]: {
      // INSERT ... SELECT balance FROM credit_balances WHERE user_id = ? —
      // inserts nothing when the balance row does not exist (SQL semantics).
      run(a) {
        const bal = t.credit_balances.find((r) => r.user_id === a[6]);
        if (!bal) return { changes: 0 };
        t.credit_ledger.push({ id: a[0], user_id: a[1], delta: a[2], kind: a[3], ref: a[4], balance_after: bal.balance, created_at: a[5] });
        return { changes: 1 };
      },
    },
    [SQL.creditLedgerDelete]: {
      run(a) {
        const n = t.credit_ledger.length;
        t.credit_ledger = t.credit_ledger.filter((r) => r.id !== a[0]);
        return { changes: n - t.credit_ledger.length };
      },
    },
    [SQL.creditGrantIfOrderCreated]: {
      // EXISTS(order still 'created') guard — replay/race = zero side effects.
      run(a) {
        const o = t.payment_orders.find((x) => x.id === a[2]);
        if (!o || o.status !== "created") return { changes: 0 };
        const row = t.credit_balances.find((r) => r.user_id === a[0]);
        if (row) row.balance += a[1];
        else t.credit_balances.push({ user_id: a[0], balance: a[1] });
        return { changes: 1 };
      },
    },
    [SQL.creditLedgerInsertIfOrderCreated]: {
      run(a) {
        const o = t.payment_orders.find((x) => x.id === a[7]);
        if (!o || o.status !== "created") return { changes: 0 };
        const bal = t.credit_balances.find((r) => r.user_id === a[6]);
        if (!bal) return { changes: 0 };
        t.credit_ledger.push({ id: a[0], user_id: a[1], delta: a[2], kind: a[3], ref: a[4], balance_after: bal.balance, created_at: a[5] });
        return { changes: 1 };
      },
    },
    [SQL.creditLedgerRecent]: {
      all: (a) =>
        clone(
          t.credit_ledger
            .filter((r) => r.user_id === a[0])
            .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))
            .slice(0, a[1]),
        ),
    },
    [SQL.paymentOrderInsert]: {
      run(a) {
        if (a[3] && t.payment_orders.some((o) => o.provider === a[2] && o.provider_ref === a[3])) {
          throw new Error("UNIQUE constraint failed: payment_orders.provider, payment_orders.provider_ref");
        }
        t.payment_orders.push({
          id: a[0], user_id: a[1], provider: a[2], provider_ref: a[3], order_ref: a[4],
          sku: a[5], amount_cents: a[6], credits: a[7], status: a[8], created_at: a[9], settled_at: null,
        });
        return { changes: 1 };
      },
    },
    [SQL.paymentOrderSetRef]: {
      run(a) {
        const o = t.payment_orders.find((x) => x.id === a[1]);
        if (o) { o.provider_ref = a[0]; return { changes: 1 }; }
        return { changes: 0 };
      },
    },
    [SQL.paymentOrderById]: { first: (a) => clone(t.payment_orders.find((o) => o.id === a[0]) || null) },
    [SQL.paymentOrderByRef]: {
      first: (a) => clone(t.payment_orders.find((o) => o.provider === a[0] && o.provider_ref === a[1]) || null),
    },
    [SQL.paymentOrderSettle]: {
      run(a) {
        const o = t.payment_orders.find((x) => x.id === a[1]);
        if (!o || o.status !== "created") return { changes: 0 }; // the replay gate
        o.status = "settled";
        o.settled_at = a[0];
        return { changes: 1 };
      },
    },
    [SQL.paymentOrdersRecent]: {
      all: (a) =>
        clone(
          t.payment_orders
            .filter((o) => o.user_id === a[0])
            .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))
            .slice(0, a[1]),
        ),
    },
  };

  return {
    _tables: t,
    prepare(sql) {
      const h = handlers[sql];
      if (!h) throw new Error(`fake D1: unhandled SQL: ${sql}`);
      const bound = (args) => ({
        _sql: sql,
        async first() { return h.first ? h.first(args) : null; },
        async all() { return { results: h.all ? h.all(args) : [] }; },
        async run() {
          const out = h.run ? h.run(args) : undefined;
          return { success: true, meta: { changes: out && typeof out.changes === "number" ? out.changes : 1 } };
        },
      });
      return { bind: (...args) => bound(args), ...bound([]) };
    },
    // D1 batch: statements execute sequentially as one transaction; per-statement
    // results mirror D1's { success, meta } for writes and { results } for reads.
    async batch(stmts) {
      const out = [];
      for (const s of stmts) {
        if (s._sql && handlers[s._sql] && handlers[s._sql].run) out.push(await s.run());
        else if (s._sql && handlers[s._sql] && handlers[s._sql].all) out.push(await s.all());
        else out.push({ results: [await s.first()] });
      }
      return out;
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

export function createFakeR2() {
  const store = new Map();
  return {
    _store: store,
    async get(key) {
      const o = store.get(key);
      if (!o) return null;
      return { body: o.bytes, httpMetadata: { contentType: o.mime } };
    },
    async put(key, bytes, opts) {
      store.set(key, {
        bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        mime: opts?.httpMetadata?.contentType || "application/octet-stream",
      });
    },
  };
}

export async function drainMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
