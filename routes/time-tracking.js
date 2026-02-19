/**
 * Time tracking routes.
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

// ── GET /time-tracking ─────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const role = getRole(req.user);
    const ownerId = ownerIdFor(req.user);
    const { user_id } = req.query;

    let targetUserId = req.user.id;
    if (user_id && (isAdmin(req.user) || role === 'manager')) {
      targetUserId = parseInt(user_id, 10);
    }

    if (role === 'va' && targetUserId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden', message: 'VA access denied' });
    }

    const entries = db.prepare(`
      SELECT te.*, t.title as task_title
      FROM time_entries te
      LEFT JOIN tasks t ON t.id = te.task_id
      WHERE te.user_id = ?
      ORDER BY te.created_at DESC
      LIMIT 100
    `).all(targetUserId);

    res.json({ entries });
  } catch (err) {
    console.error('List time entries error:', err);
    res.status(500).json({ error: 'Failed to fetch time entries' });
  }
});

// ── POST /time-tracking ────────────────────────────
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const role = getRole(req.user);
    const ownerId = ownerIdFor(req.user);
    const { task_id, start_time, end_time, duration, notes } = req.body;

    if (!task_id) {
      return res.status(400).json({ error: 'ValidationError', message: 'task_id is required' });
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (role === 'va') {
      const perm = db.prepare(`
        SELECT 1 FROM user_permissions
        WHERE user_id = ? AND resource_type = 'task' AND resource_id = ?
      `).get(req.user.id, String(task_id));
      if (!perm) {
        return res.status(403).json({ error: 'Forbidden', message: 'No access to this task' });
      }
    } else if (task.user_id !== ownerId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Task not in your account' });
    }

    let durationSeconds = parseInt(duration || 0, 10) || 0;
    if (start_time && end_time) {
      durationSeconds = Math.max(0, Math.floor((new Date(end_time) - new Date(start_time)) / 1000));
    }

    const result = db.prepare(`
      INSERT INTO time_entries (user_id, task_id, start_time, end_time, duration, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      task_id,
      start_time || null,
      end_time || null,
      durationSeconds,
      notes || null
    );

    const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ entry });
  } catch (err) {
    console.error('Create time entry error:', err);
    res.status(500).json({ error: 'Failed to log time entry' });
  }
});

module.exports = router;
