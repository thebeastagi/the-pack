// the-pack — shared utilities. Zero dependencies; Web Standards only.

export function uuid() {
  return crypto.randomUUID();
}

export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data) {
  // Accepts strings OR raw bytes (Uint8Array/ArrayBuffer views) — webhook
  // verification hashes the raw request body, never its decoded text.
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison for equal-length hex digests.
export function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const RESERVED_SLUGS = new Set(["api", "den", "dens", "admin", "health", "ws", "assets", "www"]);

export function isHandle(v) {
  return typeof v === "string" && HANDLE_RE.test(v);
}
export function isSlug(v) {
  return typeof v === "string" && SLUG_RE.test(v) && !RESERVED_SLUGS.has(v);
}
export function clampStr(v, max) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function apiError(status, code, message) {
  return json({ ok: false, error: { code, message } }, { status });
}

export function nowIso() {
  return new Date().toISOString();
}

// ─── WebSocket frame coercion ────────────────────────────────────────────────
// FLEET RULE (Jul-20 lesson): Workers Durable Objects may deliver binary frames
// as Blob, not ArrayBuffer. NEVER instanceof-gate WS frames — coerce instead.
export async function coerceToText(frame) {
  if (typeof frame === "string") return frame;
  if (frame == null) return "";
  if (frame instanceof ArrayBuffer) return new TextDecoder().decode(frame);
  if (ArrayBuffer.isView(frame)) {
    return new TextDecoder().decode(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
  }
  // Blob (incl. cross-realm): check structurally, not via instanceof.
  if (typeof frame === "object" && typeof frame.text === "function" && typeof frame.size === "number") {
    return await frame.text();
  }
  return "";
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "0.0.0.0";
}

// Best-effort per-isolate fixed-window rate limiter (hard guard is D1 uniqueness).
const buckets = new Map();
export function softRateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
    if (buckets.size > 5000) buckets.clear(); // memory guard
  }
  b.count += 1;
  return b.count <= limit;
}
