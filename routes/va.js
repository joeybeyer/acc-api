/**
 * VA dashboard routes.
 */
const { Router } = require('express');
const { getDb } = require('../db');

const router = Router();

function getRole(user) {
  if (!user) return 'manager';
  if (user.role) return user.role;
  return user.is_admin ? 'admin' : 'manager';
}

function ownerIdFor(user) {
  return user.owner_id || user.id;
}

function parseTags(raw) {
  try {
    return JSON.parse(raw || '[]');
  } catch (e) {
    if (typeof raw === 'string') {
      return raw.split(',').map(t => t.trim()).filter(Boolean);
    }
    return [];
  }
}

// ── GET /va/dashboard ──────────────────────────────
router.get('/dashboard', (req, res) => {
  try {
    const db = getDb();
    const role = getRole(req.user);
    if (role !== 'va') {
      return res.status(403).json({ error: 'Forbidden', message: 'VA access only' });
    }

    const ownerId = ownerIdFor(req.user);

    const permissions = db.prepare(`
      SELECT resource_type, resource_id, permission_level
      FROM user_permissions
      WHERE user_id = ?
    `).all(req.user.id);

    const taskPermissionIds = new Set(
      permissions.filter(p => p.resource_type === 'task').map(p => String(p.resource_id))
    );

    const clientPermissionIds = new Set(
      permissions.filter(p => p.resource_type === 'client').map(p => String(p.resource_id).toLowerCase())
    );

    // Fetch all tasks for owner, then filter by permissions
    const allTasks = db.prepare(`
      SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC
    `).all(ownerId);

    const assignedTasks = allTasks.filter(task => {
      if (taskPermissionIds.has(String(task.id))) return true;
      if (clientPermissionIds.size === 0) return false;
      const tags = parseTags(task.tags).map(t => String(t).toLowerCase());
      return tags.some(t => clientPermissionIds.has(t));
    }).map(t => ({ ...t, tags: parseTags(t.tags) }));

    const timeEntries = db.prepare(`
      SELECT te.*, t.title as task_title
      FROM time_entries te
      LEFT JOIN tasks t ON t.id = te.task_id
      WHERE te.user_id = ?
      ORDER BY te.created_at DESC
      LIMIT 50
    `).all(req.user.id);

    const completedCount = assignedTasks.filter(t => t.status === 'completed').length;
    const durationSeconds = db.prepare(`
      SELECT COALESCE(SUM(duration), 0) as total
      FROM time_entries
      WHERE user_id = ?
    `).get(req.user.id).total;

    res.json({
      user: { id: req.user.id, name: req.user.name, email: req.user.email },
      permissions,
      tasks: assignedTasks,
      time_entries: timeEntries,
      metrics: {
        tasks_completed: completedCount,
        tasks_active: assignedTasks.filter(t => t.status !== 'completed').length,
        hours_logged: Math.round((durationSeconds / 3600) * 10) / 10,
      }
    });
  } catch (err) {
    console.error('VA dashboard error:', err);
    res.status(500).json({ error: 'Failed to load VA dashboard' });
  }
});

module.exports = router;
