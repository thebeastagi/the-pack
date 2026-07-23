-- 0009 — email↔username permanent binding (login recovery, 2026-07-23).
-- The CF Access edge OTP-verifies an email on every visit; from now on the
-- worker RECORDS that verified email against the account at claim/recovery
-- time. One verified email ⇒ exactly one account (partial unique index), so
-- a returning email deterministically maps back to its username.
-- Legacy rows keep their self-asserted (unverified) emails untouched;
-- they get promoted to verified on first successful recovery (grandfather
-- window guarded in code by created_at cutoff — see src/auth.js).
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
CREATE UNIQUE INDEX idx_users_verified_email ON users (lower(email)) WHERE email_verified_at IS NOT NULL;
