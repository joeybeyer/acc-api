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
      role            TEXT DEFAULT 'manager',
      owner_id        INTEGER,
      trial_ends_at   DATETIME,
      stripe_customer_id      TEXT,
      stripe_subscription_id  TEXT,
      is_admin        INTEGER DEFAULT 0,
      is_active       INTEGER DEFAULT 1,
      created_at      DATETIME DEFAULT (datetime('now')),
      updated_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id)
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

    -- ─── Affiliates ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS affiliates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT,
      afid            TEXT UNIQUE NOT NULL,
      email           TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      default_rpc     REAL DEFAULT 25,
      created_at      DATETIME DEFAULT (datetime('now'))
    );

    -- ─── Affiliate Sessions ──────────────────────────────
    CREATE TABLE IF NOT EXISTS affiliate_sessions (
      id              TEXT PRIMARY KEY,
      affiliate_id    INTEGER NOT NULL,
      expires_at      DATETIME NOT NULL,
      created_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (affiliate_id) REFERENCES affiliates(id)
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

    -- ─── User Permissions (RBAC) ────────────────────────
    CREATE TABLE IF NOT EXISTS user_permissions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      resource_type   TEXT NOT NULL,
      resource_id     TEXT NOT NULL,
      permission_level TEXT DEFAULT 'view',
      created_at      DATETIME DEFAULT (datetime('now')),
      UNIQUE(user_id, resource_type, resource_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ─── Time Entries ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS time_entries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      task_id         INTEGER,
      start_time      DATETIME,
      end_time        DATETIME,
      duration        INTEGER DEFAULT 0,
      notes           TEXT,
      created_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    -- ─── Performance Metrics (optional snapshots) ───────
    CREATE TABLE IF NOT EXISTS performance_metrics (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      period_start    DATETIME,
      period_end      DATETIME,
      tasks_completed INTEGER DEFAULT 0,
      hours_logged    REAL DEFAULT 0,
      score           REAL DEFAULT 0,
      created_at      DATETIME DEFAULT (datetime('now')),
      updated_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
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

    -- ─── Creative Loop: Brand Kits ───────────────────────
    CREATE TABLE IF NOT EXISTS loops_brand_kits (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      name            TEXT,
      colors          TEXT DEFAULT '[]',
      fonts           TEXT DEFAULT '[]',
      logo_url        TEXT,
      guidelines      TEXT,
      created_at      DATETIME DEFAULT (datetime('now')),
      updated_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ─── Creative Loop: Batch Runs ───────────────────────
    CREATE TABLE IF NOT EXISTS loops_batches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      name            TEXT,
      status          TEXT DEFAULT 'queued',
      total_runs      INTEGER DEFAULT 0,
      created_at      DATETIME DEFAULT (datetime('now')),
      updated_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ─── Creative Loop: Runs ─────────────────────────────
    CREATE TABLE IF NOT EXISTS loops_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      brand_kit_id    INTEGER,
      batch_id        INTEGER,
      prompt          TEXT,
      style           TEXT,
      quantity        INTEGER DEFAULT 1,
      status          TEXT DEFAULT 'queued',
      model           TEXT,
      error           TEXT,
      created_at      DATETIME DEFAULT (datetime('now')),
      updated_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (brand_kit_id) REFERENCES loops_brand_kits(id),
      FOREIGN KEY (batch_id) REFERENCES loops_batches(id)
    );

    -- ─── Creative Loop: Creatives ────────────────────────
    CREATE TABLE IF NOT EXISTS loops_creatives (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          INTEGER NOT NULL,
      user_id         INTEGER NOT NULL,
      prompt          TEXT,
      style           TEXT,
      variant_index   INTEGER DEFAULT 1,
      status          TEXT DEFAULT 'queued',
      task_id         TEXT,
      image_url       TEXT,
      copy_variants   TEXT DEFAULT '[]',
      created_at      DATETIME DEFAULT (datetime('now')),
      updated_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES loops_runs(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ─── Creative Loop: A/B Tests ────────────────────────
    CREATE TABLE IF NOT EXISTS loops_ab_tests (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      creative_id     INTEGER NOT NULL,
      platform        TEXT,
      impressions     INTEGER DEFAULT 0,
      clicks          INTEGER DEFAULT 0,
      conversions     INTEGER DEFAULT 0,
      spend           REAL DEFAULT 0,
      revenue         REAL DEFAULT 0,
      created_at      DATETIME DEFAULT (datetime('now')),
      updated_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (creative_id) REFERENCES loops_creatives(id)
    );

    -- ─── Revenue Dashboard ─────────────────────────────
    CREATE TABLE IF NOT EXISTS revenue_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      amount          REAL NOT NULL,
      source          TEXT,
      date            DATETIME,
      notes           TEXT,
      created_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS revenue_goals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      period          TEXT NOT NULL,
      target_amount   REAL NOT NULL,
      created_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS revenue_settings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      default_rpc     REAL DEFAULT 25,
      retreaver_api_key TEXT,
      created_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ─── Dialer: Leads ─────────────────────────────────
    CREATE TABLE IF NOT EXISTS dialer_leads (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      name            TEXT,
      phone           TEXT NOT NULL,
      company         TEXT,
      status          TEXT DEFAULT 'new',
      created_at      DATETIME DEFAULT (datetime('now')),
      updated_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ─── Dialer: Call Logs ─────────────────────────────
    CREATE TABLE IF NOT EXISTS dialer_call_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      lead_id         INTEGER,
      call_sid        TEXT,
      direction       TEXT DEFAULT 'outbound',
      status          TEXT,
      from_number     TEXT,
      to_number       TEXT,
      duration_seconds INTEGER DEFAULT 0,
      started_at      DATETIME,
      ended_at        DATETIME,
      created_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (lead_id) REFERENCES dialer_leads(id)
    );

    -- ─── Modules ───────────────────────────────────────
    CREATE TABLE IF NOT EXISTS modules (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      slug            TEXT UNIQUE NOT NULL,
      name            TEXT NOT NULL,
      price_monthly   REAL DEFAULT 0,
      description     TEXT,
      created_at      DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_modules (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      module_slug     TEXT NOT NULL,
      status          TEXT DEFAULT 'active',
      created_at      DATETIME DEFAULT (datetime('now')),
      UNIQUE(user_id, module_slug),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    INSERT OR IGNORE INTO modules (slug, name, price_monthly, description)
    VALUES ('revenue_dashboard', 'Revenue Dashboard', 29, 'Revenue tracking, call conversions, and goals');

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
    CREATE INDEX IF NOT EXISTS idx_loops_runs_user  ON loops_runs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_loops_creatives  ON loops_creatives(run_id);
    CREATE INDEX IF NOT EXISTS idx_loops_batches    ON loops_batches(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_loops_ab_tests   ON loops_ab_tests(creative_id);
    CREATE INDEX IF NOT EXISTS idx_revenue_payments_user ON revenue_payments(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_revenue_goals_user    ON revenue_goals(user_id, period);
    CREATE INDEX IF NOT EXISTS idx_revenue_settings_user ON revenue_settings(user_id);
    CREATE INDEX IF NOT EXISTS idx_dialer_leads_user     ON dialer_leads(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_dialer_calls_user     ON dialer_call_logs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_dialer_calls_sid      ON dialer_call_logs(call_sid);
    CREATE INDEX IF NOT EXISTS idx_user_modules          ON user_modules(user_id, module_slug);
    CREATE INDEX IF NOT EXISTS idx_permissions_user      ON user_permissions(user_id, resource_type);
    CREATE INDEX IF NOT EXISTS idx_time_entries_user     ON time_entries(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_time_entries_task     ON time_entries(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_perf_metrics_user     ON performance_metrics(user_id, period_start);
  `);
}

module.exports = { createTables };
