/**
 * Team member management (Admin/Manager).
 * Scoped by owner_id. Admins can manage their own team seats.
 */
const { Router } = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
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

const seatLimits = {
  starter: 0,
  pro: 5,
  agency: 20,
};

function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

// ── GET /users ─────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const role = getRole(req.user);
    if (role === 'va') {
      return res.status(403).json({ error: 'Forbidden', message: 'VA access denied' });
    }

    const ownerId = ownerIdFor(req.user);
    const { role: roleFilter } = req.query;

    let query = `
      SELECT id, email, name, role, owner_id, is_active, created_at, updated_at
      FROM users
      WHERE owner_id = ? OR id = ?
    `;
    const params = [ownerId, ownerId];

    if (roleFilter) {
      query += ' AND role = ?';
      params.push(roleFilter);
    }

    const users = db.prepare(query).all(...params);

    // Attach performance metrics
    const perfStmt = db.prepare(`
      SELECT
        SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as tasks_completed,
        COALESCE(SUM(te.duration), 0) as duration_seconds
      FROM tasks t
      LEFT JOIN time_entries te ON te.task_id = t.id AND te.user_id = ?
      WHERE t.user_id = ?
    `);

    const enriched = users.map(u => {
      const perf = perfStmt.get(u.id, ownerId);
      return {
        ...u,
        performance: {
          tasks_completed: perf.tasks_completed || 0,
          hours_logged: Math.round(((perf.duration_seconds || 0) / 3600) * 10) / 10,
        }
      };
    });

    res.json({ users: enriched });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ── POST /users ────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const db = getDb();
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
    }

    const ownerId = ownerIdFor(req.user);
    const { email, name, role = 'va', password } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'ValidationError', message: 'Email is required' });
    }

    if (!['va', 'manager'].includes(role)) {
      return res.status(400).json({ error: 'ValidationError', message: 'Invalid role' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) {
      return res.status(409).json({ error: 'Conflict', message: 'Email already exists' });
    }

    const plan = req.user.plan || 'starter';
    const limit = seatLimits[plan] ?? 0;
    if (limit === 0) {
      return res.status(403).json({ error: 'PlanLimit', message: 'Upgrade to add team seats' });
    }

    const currentSeats = db.prepare(`
      SELECT COUNT(*) as cnt FROM users
      WHERE owner_id = ? AND id != ? AND is_active = 1
    `).get(ownerId, ownerId).cnt;

    if (currentSeats >= limit) {
      return res.status(403).json({ error: 'PlanLimit', message: `Seat limit reached (${limit})` });
    }

    const tempPassword = password || generatePassword();
    const passwordHash = bcrypt.hashSync(tempPassword, 12);

    const result = db.prepare(`
      INSERT INTO users (email, password_hash, name, plan, role, owner_id, is_admin, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 0, 1)
    `).run(
      email.toLowerCase().trim(),
      passwordHash,
      name || null,
      plan,
      role,
      ownerId
    );

    const user = db.prepare(`
      SELECT id, email, name, role, owner_id, is_active, created_at
      FROM users WHERE id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ user, temporary_password: password ? undefined : tempPassword });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ── PATCH /users/:id ───────────────────────────────
router.patch('/:id', (req, res) => {
  try {
    const db = getDb();
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
    }

    const ownerId = ownerIdFor(req.user);
    const { id } = req.params;

    const existing = db.prepare(`
      SELECT id, owner_id FROM users WHERE id = ? AND (owner_id = ? OR id = ?)
    `).get(id, ownerId, ownerId);

    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { name, role, is_active } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (role !== undefined) {
      if (!['va', 'manager'].includes(role)) {
        return res.status(400).json({ error: 'ValidationError', message: 'Invalid role' });
      }
      updates.push('role = ?');
      params.push(role);
    }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }

    if (!updates.length) {
      return res.status(400).json({ error: 'ValidationError', message: 'Nothing to update' });
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const user = db.prepare(`
      SELECT id, email, name, role, owner_id, is_active, created_at, updated_at
      FROM users WHERE id = ?
    `).get(id);

    res.json({ user });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ── DELETE /users/:id (soft delete) ─────────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
    }

    const ownerId = ownerIdFor(req.user);
    const { id } = req.params;

    const existing = db.prepare(`
      SELECT id FROM users WHERE id = ? AND (owner_id = ? OR id = ?)
    `).get(id, ownerId, ownerId);

    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    db.prepare('UPDATE users SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
