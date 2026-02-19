/**
 * Permissions routes (grant/revoke access).
 */
const { Router } = require('express');
const { getDb } = require('../db');

const router = Router();

function getRole(user) {
  if (!user) return 'manager';
  if (user.role) return user.role;
  return user.is_admin ? 'admin' : 'manager';
}

function isAdmin(user) {
  return getRole(user) === 'admin';
}

function ownerIdFor(user) {
  return user.owner_id || user.id;
}

// ── GET /permissions ───────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const role = getRole(req.user);
    if (role === 'va') {
      return res.status(403).json({ error: 'Forbidden', message: 'VA access denied' });
    }

    const ownerId = ownerIdFor(req.user);
    const { user_id } = req.query;

    let query = `
      SELECT p.*
      FROM user_permissions p
      JOIN users u ON u.id = p.user_id
      WHERE (u.owner_id = ? OR u.id = ?)
    `;
    const params = [ownerId, ownerId];

    if (user_id) {
      query += ' AND p.user_id = ?';
      params.push(user_id);
    }

    const permissions = db.prepare(query).all(...params);
    res.json({ permissions });
  } catch (err) {
    console.error('List permissions error:', err);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
});

// ── POST /permissions (grant) ──────────────────────
router.post('/', (req, res) => {
  try {
    const db = getDb();
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
    }

    const ownerId = ownerIdFor(req.user);
    const { user_id, resource_type, resource_id, permission_level = 'view' } = req.body;

    if (!user_id || !resource_type || resource_id === undefined) {
      return res.status(400).json({ error: 'ValidationError', message: 'Missing required fields' });
    }

    const user = db.prepare(`
      SELECT id FROM users WHERE id = ? AND (owner_id = ? OR id = ?)
    `).get(user_id, ownerId, ownerId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    db.prepare(`
      INSERT OR REPLACE INTO user_permissions (user_id, resource_type, resource_id, permission_level)
      VALUES (?, ?, ?, ?)
    `).run(user_id, resource_type, String(resource_id), permission_level);

    const permission = db.prepare(`
      SELECT * FROM user_permissions
      WHERE user_id = ? AND resource_type = ? AND resource_id = ?
    `).get(user_id, resource_type, String(resource_id));

    res.status(201).json({ permission });
  } catch (err) {
    console.error('Grant permission error:', err);
    res.status(500).json({ error: 'Failed to grant permission' });
  }
});

// ── DELETE /permissions (revoke) ───────────────────
router.delete('/', (req, res) => {
  try {
    const db = getDb();
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
    }

    const ownerId = ownerIdFor(req.user);
    const { user_id, resource_type, resource_id } = req.body;

    if (!user_id || !resource_type || resource_id === undefined) {
      return res.status(400).json({ error: 'ValidationError', message: 'Missing required fields' });
    }

    const user = db.prepare(`
      SELECT id FROM users WHERE id = ? AND (owner_id = ? OR id = ?)
    `).get(user_id, ownerId, ownerId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = db.prepare(`
      DELETE FROM user_permissions
      WHERE user_id = ? AND resource_type = ? AND resource_id = ?
    `).run(user_id, resource_type, String(resource_id));

    res.json({ success: true, deleted: result.changes });
  } catch (err) {
    console.error('Revoke permission error:', err);
    res.status(500).json({ error: 'Failed to revoke permission' });
  }
});

module.exports = router;
