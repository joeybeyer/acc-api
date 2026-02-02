/**
 * Auth routes: signup, login, logout, me
 */
const { Router } = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb } = require('../db');
const { authenticate, hashApiKey } = require('../middleware/auth');

const router = Router();

// ── Helpers ─────────────────────────────────────────

function generateSessionToken() {
  return crypto.randomUUID();
}

function generateApiKey() {
  const rand = crypto.randomBytes(24).toString('hex');
  return `acc_${rand}`;
}

function createSession(db, userId) {
  const token = generateSessionToken();
  const expiryDays = parseInt(process.env.SESSION_EXPIRY_DAYS || '7', 10);

  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, datetime('now', '+' || ? || ' days'))
  `).run(token, userId, expiryDays);

  return token;
}

function cleanExpiredSessions(db) {
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
}

// ── POST /auth/signup ───────────────────────────────

router.post('/signup', (req, res) => {
  try {
    const { email, password, name, company } = req.body;

    // Validate
    if (!email || !password) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Email and password are required',
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Password must be at least 8 characters',
      });
    }

    const emailLower = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid email format',
      });
    }

    const db = getDb();

    // Check duplicate
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(emailLower);
    if (existing) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'An account with this email already exists',
      });
    }

    // Create user with 14-day trial
    const passwordHash = bcrypt.hashSync(password, 12);

    const userResult = db.prepare(`
      INSERT INTO users (email, password_hash, name, company, plan, trial_ends_at)
      VALUES (?, ?, ?, ?, 'starter', datetime('now', '+14 days'))
    `).run(emailLower, passwordHash, name || null, company || null);

    const userId = userResult.lastInsertRowid;

    // Create default API key
    const apiKey = generateApiKey();
    const keyHash = hashApiKey(apiKey);
    const keyPrefix = apiKey.substring(0, 12);

    db.prepare(`
      INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
      VALUES (?, ?, ?, 'Default')
    `).run(userId, keyHash, keyPrefix);

    // Create session
    const sessionToken = createSession(db, userId);

    // Fetch user for response
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    delete user.password_hash;

    // Clean up old sessions occasionally
    cleanExpiredSessions(db);

    res.status(201).json({
      user,
      session_token: sessionToken,
      api_key: apiKey, // shown once — cannot be retrieved later
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'InternalError', message: 'Signup failed' });
  }
});

// ── POST /auth/login ────────────────────────────────

router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Email and password are required',
      });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(
      email.toLowerCase().trim()
    );

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid email or password',
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Account is disabled. Contact support.',
      });
    }

    // Create session
    const sessionToken = createSession(db, user.id);

    delete user.password_hash;

    cleanExpiredSessions(db);

    res.json({
      user,
      session_token: sessionToken,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'InternalError', message: 'Login failed' });
  }
});

// ── POST /auth/logout ───────────────────────────────

router.post('/logout', authenticate, (req, res) => {
  try {
    const db = getDb();
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    }

    res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'InternalError', message: 'Logout failed' });
  }
});

// ── PATCH /auth/me ───────────────────────────────────

router.patch('/me', authenticate, (req, res) => {
  try {
    const { name, company } = req.body;
    const db = getDb();

    const fields = [];
    const values = [];

    if (name !== undefined) { fields.push('name = ?'); values.push(name.trim()); }
    if (company !== undefined) { fields.push('company = ?'); values.push(company.trim()); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'ValidationError', message: 'Nothing to update' });
    }

    fields.push('updated_at = datetime(\'now\')');
    values.push(req.user.id);

    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    delete user.password_hash;

    res.json({ user, message: 'Profile updated' });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'InternalError', message: 'Failed to update profile' });
  }
});

// ── GET /auth/me ────────────────────────────────────

router.get('/me', authenticate, (req, res) => {
  try {
    const db = getDb();

    // Get fresh user data
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    delete user.password_hash;

    // Include counts
    const taskCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM tasks WHERE user_id = ?'
    ).get(req.user.id).cnt;

    const apiKeyCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM api_keys WHERE user_id = ?'
    ).get(req.user.id).cnt;

    res.json({
      user: {
        ...user,
        task_count: taskCount,
        api_key_count: apiKeyCount,
      }
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'InternalError', message: 'Failed to fetch user' });
  }
});

module.exports = router;
