-- The Pack — voice dens: daily usage cap + kill flag (counts-only, NO audio)
CREATE TABLE voice_usage (
  day TEXT PRIMARY KEY,            -- YYYY-MM-DD (UTC)
  seconds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE voice_flags (
  k TEXT PRIMARY KEY,              -- e.g. 'kill'
  v TEXT NOT NULL DEFAULT ''
);
