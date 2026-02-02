/**
 * Schema definitions — called on fresh installs.
 * For upgrading an existing DB, use migrate.js instead.
 */

function createTables(db) {
  db.exec(`
    -- ─── Users ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email           TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      name            TEXT,
      company         TEXT,
      plan            TEXT DEFAULT 'starter',
      trial_ends_at   DATETIME,
      stripe_customer_id      TEXT,
      stripe_subscription_id  TEXT,
      is_admin        INTEGER DEFAULT 0,
      is_active       INTEGER DEFAULT 1,
      created_at      DATETIME DEFAULT (datetime('now')),
      updated_at      DATETIME DEFAULT (datetime('now'))
    );

    -- ─── API Keys ───────────────────────────────────────
    -- key_hash is SHA-256 of the full key (fast exact lookup).
    -- API keys are high-entropy random strings, so SHA-256 is
    -- the industry standard (Stripe, GitHub, AWS all do this).
    -- bcrypt is used for passwords where slowness matters.
    CREATE TABLE IF NOT EXISTS api_keys (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      key_hash        TEXT NOT NULL UNIQUE,
      key_prefix      TEXT NOT NULL,
      name            TEXT DEFAULT 'Default',
      last_used_at    DATETIME,
      created_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ─── Sessions ───────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      expires_at      DATETIME NOT NULL,
      created_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ─── Tasks ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER REFERENCES users(id),
      external_id     TEXT,
      title           TEXT NOT NULL,
      description     TEXT,
      status          TEXT DEFAULT 'backlog',
      priority        TEXT DEFAULT 'medium',
      source          TEXT DEFAULT 'api',
      tags            TEXT DEFAULT '[]',
      assignee        TEXT,
      eta_minutes     INTEGER,
      started_at      DATETIME,
      completed_at    DATETIME,
      created_at      DATETIME DEFAULT (datetime('now')),
      updated_at      DATETIME DEFAULT (datetime('now')),
      result_url      TEXT,
      notes           TEXT
    );

    -- ─── Activity Log ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS activity_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER REFERENCES users(id),
      task_id         INTEGER,
      action          TEXT NOT NULL,
      message         TEXT,
      metadata        TEXT DEFAULT '{}',
      timestamp       DATETIME DEFAULT (datetime('now'))
    );

    -- ─── Events (parsed message log) ─────────────────────
    CREATE TABLE IF NOT EXISTS events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER REFERENCES users(id),
      raw_text        TEXT NOT NULL,
      intent          TEXT,
      confidence      REAL,
      urgency         REAL,
      entities        TEXT DEFAULT '{}',
      actions_taken   TEXT DEFAULT '[]',
      source          TEXT,
      sender          TEXT,
      channel         TEXT,
      created_at      DATETIME DEFAULT (datetime('now'))
    );

    -- ─── Indexes ────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_tasks_user       ON tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_activity_user    ON activity_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_task    ON activity_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_apikeys_hash     ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);
    CREATE INDEX IF NOT EXISTS idx_events_user      ON events(user_id);
    CREATE INDEX IF NOT EXISTS idx_events_intent    ON events(user_id, intent);
  `);
}

module.exports = { createTables };
