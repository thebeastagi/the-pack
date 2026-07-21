-- The Pack — wave 2 (2026-07-21): Collections RAG (per-den xAI knowledge
-- bases) + voice wave-2 (per-den minute caps, voice spend inside the daily
-- USD ceiling).
--
-- den_collections: one xAI collection per den (created lazily on first doc).
-- den_docs: files uploaded into a den's collection; file_id maps xAI
-- citations (collections://…/files/<file_id>) back to human-readable names.
-- voice_usage_den: per-den voice seconds per UTC day (the existing
-- voice_usage table stays the GLOBAL day rollup — untouched for compat).
-- brain_usage: rebuilt to widen the kind CHECK with 'rag' + 'voice' (SQLite
-- cannot ALTER a CHECK constraint; copy-and-rename preserves all rows).

CREATE TABLE den_collections (
  den_id TEXT PRIMARY KEY REFERENCES dens(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE den_docs (
  id TEXT PRIMARY KEY,
  den_id TEXT NOT NULL REFERENCES dens(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','ready','failed')),
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_den_docs_den ON den_docs(den_id);

CREATE TABLE voice_usage_den (
  day TEXT NOT NULL,               -- YYYY-MM-DD (UTC), same convention as voice_usage
  den TEXT NOT NULL,               -- den slug
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, den)
);

CREATE TABLE brain_usage_new (
  day TEXT NOT NULL,
  den TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('search','image','chat','rag','voice')),
  calls INTEGER NOT NULL DEFAULT 0,
  ticks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, den, kind)
);
INSERT INTO brain_usage_new (day, den, kind, calls, ticks)
  SELECT day, den, kind, calls, ticks FROM brain_usage;
DROP TABLE brain_usage;
ALTER TABLE brain_usage_new RENAME TO brain_usage;
