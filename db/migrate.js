#!/usr/bin/env node
/**
 * Migration script — upgrades an existing Agency Command Center database
 * to the multi-tenant SaaS schema.
 *
 * Safe to run multiple times (idempotent).
 *
 * Usage:
 *   cd /home/admin/activity-center/api
 *   node db/migrate.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// ── Resolve DB path ───────────────────────────────────
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.resolve(__dirname, '..', '..', 'db', 'tasks.db');

console.log(`\n📦 Migrating database: ${dbPath}\n`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Helper: check if column exists ────────────────────
function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

// ── Helper: check if table exists ─────────────────────
function tableExists(name) {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name);
  return !!row;
}

// ── Run inside a transaction ──────────────────────────
const migrate = db.transaction(() => {
  // ─── Step 1: Create new tables ─────────────────────
  console.log('1️⃣  Creating new tables...');

  db.exec(`
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

    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      expires_at      DATETIME NOT NULL,
      created_at      DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

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
  `);

  // ─── Step 2: Add user_id columns if missing ────────
  console.log('2️⃣  Adding user_id columns...');

  if (tableExists('tasks') && !columnExists('tasks', 'user_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN user_id INTEGER REFERENCES users(id)');
    console.log('   ✅ Added user_id to tasks');
  } else {
    console.log('   ⏭️  tasks.user_id already exists');
  }

  if (tableExists('activity_log') && !columnExists('activity_log', 'user_id')) {
    db.exec('ALTER TABLE activity_log ADD COLUMN user_id INTEGER REFERENCES users(id)');
    console.log('   ✅ Added user_id to activity_log');
  } else {
    console.log('   ⏭️  activity_log.user_id already exists');
  }

  // ─── Step 2.5: Add role + owner_id ───────────────
  console.log('2️⃣➕  Adding role + owner_id columns...');

  if (!columnExists('users', 'role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'manager'");
    console.log('   ✅ Added users.role');
  } else {
    console.log('   ⏭️  users.role already exists');
  }

  if (!columnExists('users', 'owner_id')) {
    db.exec('ALTER TABLE users ADD COLUMN owner_id INTEGER');
    console.log('   ✅ Added users.owner_id');
  } else {
    console.log('   ⏭️  users.owner_id already exists');
  }

  // Normalize roles + owner_id
  db.exec("UPDATE users SET role = CASE WHEN is_admin = 1 THEN 'admin' ELSE COALESCE(role, 'manager') END WHERE role IS NULL OR role = ''");
  db.exec('UPDATE users SET owner_id = id WHERE owner_id IS NULL');

  // ─── Step 3: Create indexes ────────────────────────
  console.log('3️⃣  Creating indexes...');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_user       ON tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_activity_user    ON activity_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_task    ON activity_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_apikeys_hash     ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);
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

  // ─── Step 3.5: Seed modules ─────────────────────
  console.log('3️⃣➕  Seeding modules...');

  db.prepare(`
    INSERT OR IGNORE INTO modules (slug, name, price_monthly, description)
    VALUES ('revenue_dashboard', 'Revenue Dashboard', 29, 'Revenue tracking, call conversions, and goals')
  `).run();

  // ─── Step 4: Create admin user (Joey) ──────────────
  console.log('4️⃣  Setting up admin user...');

  const adminEmail = process.env.ADMIN_EMAIL || 'joey@hollandexteriors.com';
  let adminPassword = process.env.ADMIN_PASSWORD;
  let passwordGenerated = false;

  if (!adminPassword) {
    adminPassword = crypto.randomBytes(20).toString('base64url');
    passwordGenerated = true;
  }

  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);

  if (!existingUser) {
    const hash = bcrypt.hashSync(adminPassword, 12);
    db.prepare(`
      INSERT INTO users (email, password_hash, name, company, plan, is_admin, is_active)
      VALUES (?, ?, 'Joey', 'Holland Exteriors', 'agency', 1, 1)
    `).run(adminEmail, hash);

    console.log(`   ✅ Created admin user: ${adminEmail}`);
    if (passwordGenerated) {
      console.log(`   🔑 Generated password: ${adminPassword}`);
      console.log('   ⚠️  SAVE THIS — it won\'t be shown again!');
    }
  } else {
    console.log(`   ⏭️  Admin user already exists (id=${existingUser.id})`);
  }

  // ─── Step 5: Map existing API key ──────────────────
  console.log('5️⃣  Mapping API key...');

  const apiKey = process.env.ADMIN_API_KEY || 'acc-live-20260129-4f2968fe5374c0d2';
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const keyPrefix = apiKey.substring(0, 12);

  const existingKey = db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(keyHash);

  if (!existingKey) {
    db.prepare(`
      INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
      VALUES (1, ?, ?, 'Legacy Key')
    `).run(keyHash, keyPrefix);
    console.log(`   ✅ Mapped API key (${keyPrefix}...) → user #1`);
  } else {
    console.log('   ⏭️  API key already mapped');
  }

  // ─── Step 6: Assign orphaned data to user #1 ──────
  console.log('6️⃣  Assigning existing data to admin...');

  const taskResult = db.prepare('UPDATE tasks SET user_id = 1 WHERE user_id IS NULL').run();
  console.log(`   ✅ Updated ${taskResult.changes} tasks`);

  const activityResult = db.prepare('UPDATE activity_log SET user_id = 1 WHERE user_id IS NULL').run();
  console.log(`   ✅ Updated ${activityResult.changes} activity entries`);
});

// ── Execute ──────────────────────────────────────────
try {
  migrate();
  console.log('\n✅ Migration complete!\n');
} catch (err) {
  console.error('\n❌ Migration failed:', err.message);
  console.error(err.stack);
  process.exit(1);
} finally {
  db.close();
}
