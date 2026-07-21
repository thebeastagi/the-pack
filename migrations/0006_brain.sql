-- The Pack — Grok brain upgrades (2026-07-21): per-den brain tier + live-search
-- toggle, and a spend ledger for paid xAI surfaces (server-side search tools,
-- image generation). Ledger rows are written per den AND under the '*' global
-- sentinel so cap checks are single-row reads. `ticks` = xAI's exact
-- cost_in_usd_ticks (1 USD = 10,000,000,000 ticks); `calls` = billable tool
-- calls / images. Fail-closed: caps refuse the paid call, never the den.
ALTER TABLE dens ADD COLUMN brain_tier TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE dens ADD COLUMN search_tools INTEGER NOT NULL DEFAULT 1;

CREATE TABLE brain_usage (
  day TEXT NOT NULL,               -- YYYY-MM-DD (UTC)
  den TEXT NOT NULL,               -- den slug, or '*' for the global rollup
  kind TEXT NOT NULL CHECK (kind IN ('search','image','chat')),
  calls INTEGER NOT NULL DEFAULT 0,
  ticks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, den, kind)
);
