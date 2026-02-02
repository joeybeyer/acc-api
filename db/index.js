/**
 * Database connection singleton.
 * All modules import getDb() — one connection per process.
 */
const Database = require('better-sqlite3');
const path = require('path');

let db = null;

function getDb() {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH
      ? path.resolve(process.env.DATABASE_PATH)
      : path.resolve(__dirname, '..', '..', 'db', 'tasks.db');

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  }
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
