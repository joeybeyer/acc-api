/**
 * API key management routes.
 * Keys are shown in full ONCE on creation, then only prefix is visible.
 */
const { Router } = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { hashApiKey } = require('../middleware/auth');
const { planGate } = require('../middleware/planGate');

const router = Router();

// ── Helper ──────────────────────────────────────────

function generateApiKey() {
  const rand = crypto.randomBytes(24).toString('hex');
  return `acc_${rand}`;
}

// ── GET /api-keys ───────────────────────────────────

router.get('/', (req, res) => {
  try {
    const db = getDb();

    const keys = db.prepare(`
      SELECT id, key_prefix, name, last_used_at, created_at
      FROM api_keys
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(req.user.id);

    res.json(keys);
  } catch (err) {
    console.error('List API keys error:', err);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// ── POST /api-keys ──────────────────────────────────

router.post('/', planGate('create_api_key'), (req, res) => {
  try {
    const db = getDb();
    const { name } = req.body;

    const apiKey = generateApiKey();
    const keyHash = hashApiKey(apiKey);
    const keyPrefix = apiKey.substring(0, 12);

    const result = db.prepare(`
      INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, keyHash, keyPrefix, name || 'Untitled');

    res.status(201).json({
      id: result.lastInsertRowid,
      key: apiKey, // shown ONCE — cannot be retrieved later
      key_prefix: keyPrefix,
      name: name || 'Untitled',
      message: 'Save this key now — it won\'t be shown again.',
    });
  } catch (err) {
    console.error('Create API key error:', err);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// ── DELETE /api-keys/:id ────────────────────────────

router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    // Verify ownership
    const key = db.prepare(
      'SELECT * FROM api_keys WHERE id = ? AND user_id = ?'
    ).get(id, req.user.id);

    if (!key) {
      return res.status(404).json({ error: 'API key not found' });
    }

    // Prevent deleting the last key
    const count = db.prepare(
      'SELECT COUNT(*) as cnt FROM api_keys WHERE user_id = ?'
    ).get(req.user.id).cnt;

    if (count <= 1) {
      return res.status(400).json({
        error: 'CannotDelete',
        message: 'You must keep at least one API key.',
      });
    }

    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);

    res.json({ success: true, deleted: key.key_prefix });
  } catch (err) {
    console.error('Delete API key error:', err);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

module.exports = router;
