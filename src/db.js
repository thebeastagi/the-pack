// the-pack — D1 data layer. All SQL is centralized here as named constants so
// the hermetic test double (test/fakes.js) can dispatch on exact statements.
import { nowIso, uuid } from "./util.js";

export const SQL = {
  insertUser:
    "INSERT INTO users (id, handle, display_name, email, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  userByHandle: "SELECT * FROM users WHERE handle = ? COLLATE NOCASE",
  userById: "SELECT * FROM users WHERE id = ?",
  touchUser: "UPDATE users SET last_seen_at = ? WHERE id = ?",

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
};

export async function createUser(db, { handle, displayName = "", email = null, kind = "human" }) {
  const user = {
    id: uuid(),
    handle,
    display_name: displayName || handle,
    email,
    kind,
    created_at: nowIso(),
    last_seen_at: null,
  };
  await db
    .prepare(SQL.insertUser)
    .bind(user.id, user.handle, user.display_name, user.email, user.kind, user.created_at)
    .run();
  return user;
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
