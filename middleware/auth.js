/**
 * Authentication middleware.
 *
 * Supports two auth methods (checked in order):
 *   1. Bearer token  →  Authorization: Bearer <session_id>
 *   2. API key        →  X-API-Key: <key>  (or ?api_key= query param)
 *
 * On success, attaches req.user (without password_hash).
 */
const crypto = require('crypto');
const { getDb } = require('../db');

// ── Helpers ─────────────────────────────────────────

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function sanitizeUser(row) {
  if (!row) return null;
  const user = { ...row };
  delete user.password_hash;
  return user;
}

// ── Main middleware ─────────────────────────────────

function authenticate(req, res, next) {
  const db = getDb();

  // ── 1. Bearer token (session) ──────────────────
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const session = db.prepare(
        `SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')`
      ).get(token);

      if (session) {
        const user = db.prepare(
          'SELECT * FROM users WHERE id = ? AND is_active = 1'
        ).get(session.user_id);

        if (user) {
          req.user = sanitizeUser(user);
          return next();
        }
      }
    }
  }

  // ── 2. API key ─────────────────────────────────
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey) {
    const keyHash = hashApiKey(apiKey);
    const keyRow = db.prepare(
      'SELECT * FROM api_keys WHERE key_hash = ?'
    ).get(keyHash);

    if (keyRow) {
      const user = db.prepare(
        'SELECT * FROM users WHERE id = ? AND is_active = 1'
      ).get(keyRow.user_id);

      if (user) {
        // Update last_used_at (fire-and-forget, non-blocking)
        db.prepare(
          `UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`
        ).run(keyRow.id);

        req.user = sanitizeUser(user);
        return next();
      }
    }

    // ── 3. Legacy fallback ─────────────────────────
    // Safety net during migration — remove after confirming
    if (process.env.LEGACY_API_KEY && apiKey === process.env.LEGACY_API_KEY) {
      const admin = db.prepare(
        'SELECT * FROM users WHERE is_admin = 1 AND is_active = 1 LIMIT 1'
      ).get();

      if (admin) {
        req.user = sanitizeUser(admin);
        return next();
      }
    }
  }

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Valid authentication required (Bearer token or X-API-Key)',
  });
}

/**
 * Optional auth — same logic but doesn't reject.
 * Sets req.user if auth present, otherwise continues with req.user = null.
 */
function optionalAuth(req, res, next) {
  const db = getDb();

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const session = db.prepare(
        `SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')`
      ).get(token);
      if (session) {
        const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(session.user_id);
        if (user) req.user = sanitizeUser(user);
      }
    }
  }

  if (!req.user) {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (apiKey) {
      const keyHash = hashApiKey(apiKey);
      const keyRow = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash);
      if (keyRow) {
        const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(keyRow.user_id);
        if (user) req.user = sanitizeUser(user);
      }

      if (!req.user && process.env.LEGACY_API_KEY && apiKey === process.env.LEGACY_API_KEY) {
        const admin = db.prepare('SELECT * FROM users WHERE is_admin = 1 AND is_active = 1 LIMIT 1').get();
        if (admin) req.user = sanitizeUser(admin);
      }
    }
  }

  next();
}

module.exports = { authenticate, optionalAuth, hashApiKey };
