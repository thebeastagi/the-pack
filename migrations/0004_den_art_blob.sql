-- The Pack — den artwork bytes (R2 blocked: not enabled on account; D1-blob
-- is the zero-new-infra store for banner-scale art). dens.art_url marks presence.
CREATE TABLE den_art (
  den_id TEXT PRIMARY KEY REFERENCES dens(id),
  mime TEXT NOT NULL DEFAULT 'image/png',
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);
