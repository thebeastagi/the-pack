-- The Pack — Phase 1 monetisation (2026-07-21, pack-monetisation-plan §4):
-- prepaid "den-fire credits" (1 credit = $0.01 list) + payment orders.
-- Additive-only. Credits are non-transferable single-merchant prepaid units:
-- no cash-out, no P2P. The ledger is the audit trail for every grant/burn.
--
-- Money-safety invariants (enforced in src/credits.js, not just here):
--   * balance never goes negative (guarded UPDATE ... WHERE balance >= ?)
--   * a settled payment can never credit twice (guarded UPDATE on
--     payment_orders.status + UNIQUE(provider, provider_ref))
--   * every balance mutation appends a ledger row in the SAME D1 batch
CREATE TABLE credit_balances (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)  -- credits (1 = $0.01 list)
);

CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,            -- uuid
  user_id TEXT NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,         -- +grant / -burn
  kind TEXT NOT NULL,             -- 'purchase','burn:search','burn:image','burn:voice','burn:chat','grant:pro','refund','admin'
  ref TEXT,                       -- den slug / payment order id / session id
  balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX credit_ledger_user ON credit_ledger(user_id, created_at DESC);

CREATE TABLE payment_orders (
  id TEXT PRIMARY KEY,            -- our uuid (embedded in the AllScale order_id)
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,         -- 'allscale' | 'x402' | 'stripe'
  provider_ref TEXT,              -- checkout_intent_id / tx hash (NULL until upstream responds)
  order_ref TEXT NOT NULL,        -- full merchant order_id sent upstream: pack:{userId}:{uuid}
  sku TEXT NOT NULL,              -- 'spark' | 'ember' | 'fire' | 'inferno'
  amount_cents INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  status TEXT NOT NULL,           -- 'created','settled','expired','refunded'
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE(provider, provider_ref)  -- replay rejection (D1-native idempotency)
);
CREATE INDEX payment_orders_user ON payment_orders(user_id, created_at DESC);
