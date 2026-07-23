// the-pack — D1 data layer. All SQL is centralized here as named constants so
// the hermetic test double (test/fakes.js) can dispatch on exact statements.
import { nowIso, uuid } from "./util.js";

export const SQL = {
  insertUser:
    "INSERT INTO users (id, handle, display_name, email, email_verified_at, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  userByHandle: "SELECT * FROM users WHERE handle = ? COLLATE NOCASE",
  userById: "SELECT * FROM users WHERE id = ?",
  touchUser: "UPDATE users SET last_seen_at = ? WHERE id = ?",
  // Login recovery (0009): a VERIFIED email maps to exactly one account
  // (partial unique index idx_users_verified_email). Legacy = pre-0009
  // self-asserted email; promoted to verified on first recovery (code-gated
  // by created_at cutoff so post-0009 typed emails can never be hijack bait).
  userByVerifiedEmail:
    "SELECT * FROM users WHERE email IS NOT NULL AND lower(email) = lower(?) AND email_verified_at IS NOT NULL LIMIT 1",
  legacyUserByEmail:
    "SELECT * FROM users WHERE email IS NOT NULL AND lower(email) = lower(?) AND email_verified_at IS NULL AND kind = 'human' AND created_at < ? ORDER BY created_at ASC LIMIT 1",
  bindVerifiedEmail: "UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?",

  insertSession:
    "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
  sessionById: "SELECT * FROM sessions WHERE id = ?",
  deleteSession: "DELETE FROM sessions WHERE id = ?",

  insertAgentKey: "INSERT INTO agent_keys (id, user_id, label, created_at) VALUES (?, ?, ?, ?)",
  agentKeyById: "SELECT * FROM agent_keys WHERE id = ? AND revoked_at IS NULL",

  insertDen:
    "INSERT INTO dens (id, slug, name, topic, brain_tier, search_tools, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  denBySlug: "SELECT * FROM dens WHERE slug = ?",
  denById: "SELECT * FROM dens WHERE id = ?",
  listDens: "SELECT * FROM dens ORDER BY created_at ASC LIMIT 200",

  insertMember:
    "INSERT OR IGNORE INTO den_members (den_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
  memberCount: "SELECT COUNT(*) AS n FROM den_members WHERE den_id = ?",

  insertMessage:
    "INSERT INTO messages (id, den_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
  recentMessages:
    "SELECT m.id, m.body, m.created_at, u.handle, u.display_name, u.kind FROM messages m JOIN users u ON u.id = m.user_id WHERE m.den_id = ? ORDER BY m.created_at DESC LIMIT ?",

  agentUsers: "SELECT * FROM users WHERE kind = 'agent' ORDER BY created_at ASC LIMIT 100",

  voiceUsageGet: "SELECT seconds FROM voice_usage WHERE day = ?",
  voiceUsageAdd:
    "INSERT INTO voice_usage (day, seconds) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET seconds = seconds + excluded.seconds",
  voiceFlagGet: "SELECT v FROM voice_flags WHERE k = ?",
  voiceFlagSet:
    "INSERT INTO voice_flags (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",

  denSetArtUrl: "UPDATE dens SET art_url = ? WHERE id = ?",

  // ── Grok brain spend ledger (migration 0006) ─────────────────────────────
  brainUsageGet: "SELECT calls, ticks FROM brain_usage WHERE day = ? AND den = ? AND kind = ?",
  brainUsageGlobalTicks:
    "SELECT COALESCE(SUM(ticks), 0) AS ticks FROM brain_usage WHERE day = ? AND den = '*'",
  brainUsageAdd:
    "INSERT INTO brain_usage (day, den, kind, calls, ticks) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day, den, kind) DO UPDATE SET calls = calls + excluded.calls, ticks = ticks + excluded.ticks",
  brainUsageDay: "SELECT den, kind, calls, ticks FROM brain_usage WHERE day = ? ORDER BY den, kind",

  // ── wave 2 (migration 0007): den knowledge bases + per-den voice caps ────
  denCollectionGet: "SELECT * FROM den_collections WHERE den_id = ?",
  denCollectionInsert: "INSERT INTO den_collections (den_id, collection_id, created_at) VALUES (?, ?, ?)",
  denDocInsert:
    "INSERT INTO den_docs (id, den_id, file_id, name, bytes, status, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  denDocsByDen: "SELECT * FROM den_docs WHERE den_id = ? ORDER BY created_at ASC LIMIT 100",
  denDocById: "SELECT * FROM den_docs WHERE id = ? AND den_id = ?",
  denDocSetStatus: "UPDATE den_docs SET status = ? WHERE id = ?",
  denDocDelete: "DELETE FROM den_docs WHERE id = ?",
  denDocsCount: "SELECT COUNT(*) AS n FROM den_docs WHERE den_id = ?",
  denDocsReadyCount: "SELECT COUNT(*) AS n FROM den_docs WHERE den_id = ? AND status = 'ready'",
  voiceUsageDenGet: "SELECT seconds FROM voice_usage_den WHERE day = ? AND den = ?",
  voiceUsageDenAdd:
    "INSERT INTO voice_usage_den (day, den, seconds) VALUES (?, ?, ?) ON CONFLICT(day, den) DO UPDATE SET seconds = seconds + excluded.seconds",
  // ── credits + payments (migration 0008) ─────────────────────────────────
  creditBalanceGet: "SELECT balance FROM credit_balances WHERE user_id = ?",
  // The money gate: balance can never go negative, and a raced concurrent
  // debit simply changes 0 rows (caller treats that as insufficient).
  creditDebit:
    "UPDATE credit_balances SET balance = balance - ? WHERE user_id = ? AND balance >= ?",
  creditGrant:
    "INSERT INTO credit_balances (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance",
  // Settle-scoped variants: the grant/ledger only apply while the order is
  // still 'created' INSIDE the same batch transaction, so a replayed or raced
  // settle is a zero-side-effect no-op (exactly-once at the SQL level).
  creditGrantIfOrderCreated:
    "INSERT INTO credit_balances (user_id, balance) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM payment_orders WHERE id = ? AND status = 'created') ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance",
  creditLedgerInsertIfOrderCreated:
    "INSERT INTO credit_ledger (id, user_id, delta, kind, ref, balance_after, created_at) SELECT ?, ?, ?, ?, ?, balance, ? FROM credit_balances WHERE user_id = ? AND EXISTS (SELECT 1 FROM payment_orders WHERE id = ? AND status = 'created')",
  // Ledger rows always read balance AFTER the mutation inside the same batch.
  creditLedgerInsert:
    "INSERT INTO credit_ledger (id, user_id, delta, kind, ref, balance_after, created_at) SELECT ?, ?, ?, ?, ?, balance, ? FROM credit_balances WHERE user_id = ?",
  creditLedgerDelete: "DELETE FROM credit_ledger WHERE id = ?",
  creditLedgerRecent:
    "SELECT id, delta, kind, ref, balance_after, created_at FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",

  paymentOrderInsert:
    "INSERT INTO payment_orders (id, user_id, provider, provider_ref, order_ref, sku, amount_cents, credits, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  paymentOrderSetRef: "UPDATE payment_orders SET provider_ref = ? WHERE id = ?",
  paymentOrderById: "SELECT * FROM payment_orders WHERE id = ?",
  paymentOrderByRef: "SELECT * FROM payment_orders WHERE provider = ? AND provider_ref = ?",
  // The settle gate: only a still-'created' order can settle — replay/double
  // delivery changes 0 rows and the caller answers 409.
  paymentOrderSettle:
    "UPDATE payment_orders SET status = 'settled', settled_at = ? WHERE id = ? AND status = 'created'",
  paymentOrdersRecent:
    "SELECT id, provider, provider_ref, order_ref, sku, amount_cents, credits, status, created_at, settled_at FROM payment_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
};

export async function createUser(db, { handle, displayName = "", email = null, emailVerifiedAt = null, kind = "human" }) {
  const user = {
    id: uuid(),
    handle,
    display_name: displayName || handle,
    email,
    email_verified_at: emailVerifiedAt,
    kind,
    created_at: nowIso(),
    last_seen_at: null,
  };
  await db
    .prepare(SQL.insertUser)
    .bind(user.id, user.handle, user.display_name, user.email, user.email_verified_at, user.kind, user.created_at)
    .run();
  return user;
}

export async function getUserByVerifiedEmail(db, email) {
  return db.prepare(SQL.userByVerifiedEmail).bind(email).first();
}

export async function getLegacyUserByEmail(db, email, createdBefore) {
  return db.prepare(SQL.legacyUserByEmail).bind(email, createdBefore).first();
}

export async function bindVerifiedEmail(db, userId, email) {
  await db.prepare(SQL.bindVerifiedEmail).bind(email, nowIso(), userId).run();
}

export async function getUserByHandle(db, handle) {
  return db.prepare(SQL.userByHandle).bind(handle).first();
}

export async function getUserById(db, id) {
  return db.prepare(SQL.userById).bind(id).first();
}

export async function touchUser(db, id) {
  await db.prepare(SQL.touchUser).bind(nowIso(), id).run();
}

export async function createSession(db, { tokenHash, userId, expiresAt, userAgent = "" }) {
  await db
    .prepare(SQL.insertSession)
    .bind(tokenHash, userId, nowIso(), expiresAt, userAgent.slice(0, 200))
    .run();
}

export async function getSession(db, tokenHash) {
  return db.prepare(SQL.sessionById).bind(tokenHash).first();
}

export async function deleteSession(db, tokenHash) {
  await db.prepare(SQL.deleteSession).bind(tokenHash).run();
}

export async function createAgentKey(db, { keyHash, userId, label = "" }) {
  await db.prepare(SQL.insertAgentKey).bind(keyHash, userId, label.slice(0, 80), nowIso()).run();
}

export async function getAgentKey(db, keyHash) {
  return db.prepare(SQL.agentKeyById).bind(keyHash).first();
}

export async function createDen(db, { slug, name, topic = "", createdBy, brainTier = "standard", searchTools = true }) {
  const den = {
    id: uuid(),
    slug,
    name,
    topic,
    brain_tier: brainTier,
    search_tools: searchTools ? 1 : 0,
    created_by: createdBy,
    created_at: nowIso(),
  };
  await db
    .prepare(SQL.insertDen)
    .bind(den.id, den.slug, den.name, den.topic, den.brain_tier, den.search_tools, den.created_by, den.created_at)
    .run();
  return den;
}

export async function getDenBySlug(db, slug) {
  return db.prepare(SQL.denBySlug).bind(slug).first();
}

export async function getDenById(db, id) {
  return db.prepare(SQL.denById).bind(id).first();
}

export async function listDens(db) {
  const res = await db.prepare(SQL.listDens).all();
  return res.results || [];
}

export async function addMember(db, { denId, userId, role = "member" }) {
  await db.prepare(SQL.insertMember).bind(denId, userId, role, nowIso()).run();
}

export async function getMemberCount(db, denId) {
  const row = await db.prepare(SQL.memberCount).bind(denId).first();
  return row ? Number(row.n) : 0;
}

export async function createMessage(db, { denId, userId, body }) {
  const msg = { id: uuid(), den_id: denId, user_id: userId, body, created_at: nowIso() };
  await db
    .prepare(SQL.insertMessage)
    .bind(msg.id, msg.den_id, msg.user_id, msg.body, msg.created_at)
    .run();
  return msg;
}

export async function getRecentMessages(db, denId, limit = 50) {
  const res = await db.prepare(SQL.recentMessages).bind(denId, Math.min(Math.max(limit, 1), 100)).all();
  return res.results || [];
}

// ── den artwork: bytes live in R2 (phase 2.6); D1 only marks presence ──
export async function markDenArt(db, denId, artUrl) {
  await db.prepare(SQL.denSetArtUrl).bind(artUrl, denId).run();
}

// ── Grok brain spend ledger (migration 0006) ───────────────────────────────
// Every paid xAI surface (search tools, image gen, tool-enabled completions)
// logs here per den AND under the '*' global sentinel. Cap checks read single
// rows; a read failure must be treated as "over cap" (fail closed — callers).

export async function getBrainUsage(db, day, den, kind) {
  const row = await db.prepare(SQL.brainUsageGet).bind(day, den, kind).first();
  return { calls: Number(row?.calls) || 0, ticks: Number(row?.ticks) || 0 };
}

export async function getGlobalBrainTicks(db, day) {
  const row = await db.prepare(SQL.brainUsageGlobalTicks).bind(day).first();
  return Number(row?.ticks) || 0;
}

export async function addBrainUsage(db, day, den, kind, calls, ticks) {
  const c = Math.max(0, Math.round(calls));
  const t = Math.max(0, Math.round(ticks));
  for (const scope of [den, "*"]) {
    await db.prepare(SQL.brainUsageAdd).bind(day, scope, kind, c, t).run();
  }
}

export async function listBrainUsage(db, day) {
  const res = await db.prepare(SQL.brainUsageDay).bind(day).all();
  return res.results || [];
}

// ── credits + payments (migration 0008) ────────────────────────────────────
// Low-level row helpers only — the money-safety choreography (guarded debit,
// batch-atomic ledger, idempotent settle) lives in src/credits.js and
// src/payments.js so it can be tested as one unit.

export async function getCreditBalance(db, userId) {
  const row = await db.prepare(SQL.creditBalanceGet).bind(userId).first();
  return Number(row?.balance) || 0;
}

export async function listCreditLedger(db, userId, limit = 20) {
  const res = await db
    .prepare(SQL.creditLedgerRecent)
    .bind(userId, Math.min(Math.max(limit, 1), 50))
    .all();
  return res.results || [];
}

export async function createPaymentOrder(db, { id, userId, provider, orderRef, sku, amountCents, credits }) {
  await db
    .prepare(SQL.paymentOrderInsert)
    .bind(id, userId, provider, null, orderRef, sku, amountCents, credits, "created", nowIso())
    .run();
}

export async function setPaymentOrderRef(db, id, providerRef) {
  await db.prepare(SQL.paymentOrderSetRef).bind(providerRef, id).run();
}

export async function getPaymentOrderById(db, id) {
  return db.prepare(SQL.paymentOrderById).bind(id).first();
}

export async function getPaymentOrderByRef(db, provider, providerRef) {
  return db.prepare(SQL.paymentOrderByRef).bind(provider, providerRef).first();
}

export async function listPaymentOrders(db, userId, limit = 20) {
  const res = await db
    .prepare(SQL.paymentOrdersRecent)
    .bind(userId, Math.min(Math.max(limit, 1), 50))
    .all();
  return res.results || [];
}

// ── agent citizens (kind='agent') ───────────────────────────────────────────
export async function listAgentUsers(db) {
  const res = await db.prepare(SQL.agentUsers).all();
  return res.results || [];
}

// ── voice dens (counts-only; NO audio ever persisted) ──────────────────────
export async function getVoiceUsage(db, day) {
  const row = await db.prepare(SQL.voiceUsageGet).bind(day).first();
  return row ? Number(row.seconds) || 0 : 0;
}

export async function addVoiceUsage(db, day, seconds) {
  await db.prepare(SQL.voiceUsageAdd).bind(day, Math.max(0, Math.round(seconds))).run();
}

export async function getVoiceFlag(db, k) {
  const row = await db.prepare(SQL.voiceFlagGet).bind(k).first();
  return row ? String(row.v) === "1" : false;
}

export async function setVoiceFlag(db, k, on) {
  await db.prepare(SQL.voiceFlagSet).bind(k, on ? "1" : "0").run();
}

// ── wave 2: den knowledge bases (xAI Collections RAG) ─────────────────────
export async function getDenCollection(db, denId) {
  return db.prepare(SQL.denCollectionGet).bind(denId).first();
}

export async function createDenCollection(db, { denId, collectionId }) {
  await db.prepare(SQL.denCollectionInsert).bind(denId, collectionId, nowIso()).run();
  return { den_id: denId, collection_id: collectionId };
}

export async function createDenDoc(db, { denId, fileId, name, bytes, addedBy }) {
  const doc = {
    id: uuid(),
    den_id: denId,
    file_id: fileId,
    name,
    bytes,
    status: "processing",
    added_by: addedBy,
    created_at: nowIso(),
  };
  await db
    .prepare(SQL.denDocInsert)
    .bind(doc.id, doc.den_id, doc.file_id, doc.name, doc.bytes, doc.status, doc.added_by, doc.created_at)
    .run();
  return doc;
}

export async function listDenDocs(db, denId) {
  const res = await db.prepare(SQL.denDocsByDen).bind(denId).all();
  return res.results || [];
}

export async function getDenDoc(db, denId, docId) {
  return db.prepare(SQL.denDocById).bind(docId, denId).first();
}

export async function setDenDocStatus(db, docId, status) {
  await db.prepare(SQL.denDocSetStatus).bind(status, docId).run();
}

export async function deleteDenDoc(db, docId) {
  await db.prepare(SQL.denDocDelete).bind(docId).run();
}

export async function countDenDocs(db, denId) {
  const row = await db.prepare(SQL.denDocsCount).bind(denId).first();
  return row ? Number(row.n) || 0 : 0;
}

export async function countReadyDenDocs(db, denId) {
  const row = await db.prepare(SQL.denDocsReadyCount).bind(denId).first();
  return row ? Number(row.n) || 0 : 0;
}

// ── wave 2: per-den voice minute ledger (global rollup stays voice_usage) ──
export async function getVoiceUsageDen(db, day, den) {
  const row = await db.prepare(SQL.voiceUsageDenGet).bind(day, den).first();
  return row ? Number(row.seconds) || 0 : 0;
}

export async function addVoiceUsageDen(db, day, den, seconds) {
  await db.prepare(SQL.voiceUsageDenAdd).bind(day, den, Math.max(0, Math.round(seconds))).run();
}

export function publicUser(u) {
  if (!u) return null;
  return { handle: u.handle, display: u.display_name || u.handle, kind: u.kind };
}

// Brain defaults: rows pre-dating migration 0006 carry the column defaults
// ('standard' / 1); undefined (hermetic fakes aside) means the same.
export function denBrainTier(d) {
  return typeof d?.brain_tier === "string" && d.brain_tier ? d.brain_tier : "standard";
}
export function denSearchTools(d) {
  return d?.search_tools === 0 ? false : true;
}

export function publicDen(d, extra = {}) {
  return {
    slug: d.slug,
    name: d.name,
    topic: d.topic || "",
    createdAt: d.created_at,
    brainTier: denBrainTier(d),
    searchTools: denSearchTools(d),
    ...(d.art_url ? { artUrl: d.art_url } : {}),
    ...extra,
  };
}
