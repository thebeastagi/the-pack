-- 0010 — Workers-native email-OTP auth (M1 of the 2026-07-23 architecture).
-- OTP challenges live in D1 (NOT KV: one-time codes need strong consistency;
-- KV's ~60s cross-PoP propagation can make a just-written code invisible where
-- the verify lands). Rows double as the send-rate ledger (per-email / per-IP /
-- global fuses count rows in a window), so invalidated challenges still count.
--   kind = 'otp'   — 6-digit login code, 10 min TTL, 5 attempts then burned
--   kind = 'claim' — one-time claim ticket minted by a successful verify for
--                    emails with no account yet; proves email ownership to
--                    exactly one POST /api/handles (anti-squat, structural)
CREATE TABLE auth_challenges (
  id          TEXT PRIMARY KEY,           -- sha256 of the secret (code row: uuid; ticket row: sha256(ticket))
  kind        TEXT NOT NULL,              -- 'otp' | 'claim'
  email       TEXT NOT NULL,              -- lowercased at write time
  code_hash   TEXT NOT NULL,              -- sha256(code) / sha256(ticket)
  ip          TEXT,                       -- requester IP (send-rate fuse)
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_auth_challenges_email ON auth_challenges (lower(email), kind, created_at);
CREATE INDEX idx_auth_challenges_created ON auth_challenges (created_at);
CREATE INDEX idx_auth_challenges_ip ON auth_challenges (ip, created_at);

-- Dev-only outbox: written EXCLUSIVELY by the stub email sender
-- (EMAIL_PROVIDER=stub — preview/dev deployments; a real provider never
-- touches this table). Read via the 404-cloaked, ADMIN_TOKEN-gated
-- GET /api/admin/dev-mail so E2E can fetch its own OTP codes.
CREATE TABLE dev_outbox (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_dev_outbox_email ON dev_outbox (lower(email), created_at);
