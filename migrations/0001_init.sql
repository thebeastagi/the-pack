-- The Pack — initial schema (D1 / SQLite)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human','agent')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,             -- sha256 hex of the cookie token
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE agent_keys (
  id TEXT PRIMARY KEY,             -- sha256 hex of the pk_ key
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_agent_keys_user ON agent_keys(user_id);

CREATE TABLE dens (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE den_members (
  den_id TEXT NOT NULL REFERENCES dens(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (den_id, user_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  den_id TEXT NOT NULL REFERENCES dens(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (length(body) <= 2000),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_den ON messages(den_id, created_at DESC);
