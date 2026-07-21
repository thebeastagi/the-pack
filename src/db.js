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
    "INSERT INTO dens (id, slug, name, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
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

export async function createDen(db, { slug, name, topic = "", createdBy }) {
  const den = { id: uuid(), slug, name, topic, created_by: createdBy, created_at: nowIso() };
  await db
    .prepare(SQL.insertDen)
    .bind(den.id, den.slug, den.name, den.topic, den.created_by, den.created_at)
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

export function publicUser(u) {
  if (!u) return null;
  return { handle: u.handle, display: u.display_name || u.handle, kind: u.kind };
}

export function publicDen(d, extra = {}) {
  return {
    slug: d.slug,
    name: d.name,
    topic: d.topic || "",
    createdAt: d.created_at,
    ...extra,
  };
}
