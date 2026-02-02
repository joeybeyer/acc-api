/**
 * Creative Loop Engine — Database Schema
 *
 * Tables:
 *   ad_creatives      — Ad entries with prompt, metrics, lineage tracking
 *   prompt_library    — Reusable prompt templates with variable slots
 *   metric_snapshots  — Point-in-time performance snapshots for trend analysis
 *   naming_conventions — User-defined ad naming templates
 *   loop_configs      — Per-user loop settings (thresholds, schedule, auto-post)
 *   loop_runs         — History of every loop execution
 *
 * Import: require('./creative-schema').createCreativeTables(db)
 */

function createCreativeTables(db) {
  db.exec(`
    -- ─── Ad Creatives ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS ad_creatives (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL,
      external_id         TEXT UNIQUE,
      campaign_name       TEXT,
      ad_set_name         TEXT,
      variant_name        TEXT NOT NULL,
      naming_code         TEXT,
      prompt_id           INTEGER,
      platform            TEXT DEFAULT 'facebook',
      platform_ad_id      TEXT,
      platform_campaign_id TEXT,
      platform_adset_id   TEXT,
      status              TEXT DEFAULT 'draft',
      creative_type       TEXT DEFAULT 'image',
      creative_url        TEXT,
      parent_id           INTEGER,
      generation          INTEGER DEFAULT 1,
      variable_changed    TEXT,
      variable_value      TEXT,
      metrics             TEXT DEFAULT '{}',
      diagnosis           TEXT,
      diagnosis_action    TEXT,
      created_at          DATETIME DEFAULT (datetime('now')),
      updated_at          DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id)   REFERENCES users(id),
      FOREIGN KEY (prompt_id) REFERENCES prompt_library(id),
      FOREIGN KEY (parent_id) REFERENCES ad_creatives(id)
    );

    CREATE INDEX IF NOT EXISTS idx_creatives_user     ON ad_creatives(user_id);
    CREATE INDEX IF NOT EXISTS idx_creatives_status   ON ad_creatives(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_creatives_parent   ON ad_creatives(parent_id);
    CREATE INDEX IF NOT EXISTS idx_creatives_prompt   ON ad_creatives(prompt_id);
    CREATE INDEX IF NOT EXISTS idx_creatives_platform ON ad_creatives(platform_ad_id);
    CREATE INDEX IF NOT EXISTS idx_creatives_campaign ON ad_creatives(user_id, campaign_name);

    -- ─── Prompt Library ─────────────────────────────────
    CREATE TABLE IF NOT EXISTS prompt_library (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL,
      name                TEXT,
      prompt_text         TEXT NOT NULL,
      variables           TEXT DEFAULT '{}',
      category            TEXT,
      performance_score   REAL DEFAULT 0,
      times_used          INTEGER DEFAULT 0,
      best_ctr            REAL,
      best_cpa            REAL,
      created_at          DATETIME DEFAULT (datetime('now')),
      updated_at          DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_prompts_user  ON prompt_library(user_id);
    CREATE INDEX IF NOT EXISTS idx_prompts_perf  ON prompt_library(user_id, performance_score DESC);
    CREATE INDEX IF NOT EXISTS idx_prompts_cat   ON prompt_library(user_id, category);

    -- ─── Metric Snapshots ───────────────────────────────
    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      creative_id         INTEGER NOT NULL,
      snapshot_date       DATE NOT NULL,
      impressions         INTEGER DEFAULT 0,
      clicks              INTEGER DEFAULT 0,
      spend               REAL DEFAULT 0,
      conversions         INTEGER DEFAULT 0,
      ctr                 REAL,
      cpc                 REAL,
      cpa                 REAL,
      cpm                 REAL,
      frequency           REAL,
      relevance_score     REAL,
      created_at          DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (creative_id) REFERENCES ad_creatives(id)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_creative ON metric_snapshots(creative_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_date     ON metric_snapshots(creative_id, snapshot_date DESC);

    -- ─── Naming Conventions ─────────────────────────────
    CREATE TABLE IF NOT EXISTS naming_conventions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL,
      name                TEXT,
      template            TEXT NOT NULL,
      is_default          INTEGER DEFAULT 0,
      created_at          DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_naming_user ON naming_conventions(user_id);

    -- ─── Loop Configuration (per-user) ──────────────────
    CREATE TABLE IF NOT EXISTS loop_configs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL UNIQUE,
      ctr_low_threshold   REAL DEFAULT 1.0,
      ctr_winner_threshold REAL DEFAULT 2.0,
      cpa_target          REAL DEFAULT 50.0,
      cpc_multiplier      REAL DEFAULT 2.0,
      frequency_fatigue   REAL DEFAULT 3.0,
      ctr_decline_pct     REAL DEFAULT 20.0,
      auto_post           INTEGER DEFAULT 0,
      auto_pause_losers   INTEGER DEFAULT 1,
      auto_scale_winners  INTEGER DEFAULT 0,
      schedule_cron       TEXT,
      max_variants_per_run INTEGER DEFAULT 5,
      updated_at          DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ─── Loop Run History ───────────────────────────────
    CREATE TABLE IF NOT EXISTS loop_runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL,
      started_at          DATETIME DEFAULT (datetime('now')),
      completed_at        DATETIME,
      status              TEXT DEFAULT 'running',
      creatives_analyzed  INTEGER DEFAULT 0,
      variants_created    INTEGER DEFAULT 0,
      winners_found       INTEGER DEFAULT 0,
      losers_paused       INTEGER DEFAULT 0,
      errors              TEXT DEFAULT '[]',
      summary             TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_loop_runs_user ON loop_runs(user_id);
    CREATE INDEX IF NOT EXISTS idx_loop_runs_date ON loop_runs(user_id, started_at DESC);
  `);
}

module.exports = { createCreativeTables };
