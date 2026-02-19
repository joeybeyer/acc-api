/**
 * Task CRUD routes — all scoped by user_id.
 * Admin users can use ?scope=all to see everything.
 */
const { Router } = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { planGate } = require('../middleware/planGate');

const router = Router();

// ── Helper: build WHERE clause for tenant scoping ───

function getRole(user) {
  if (!user) return 'manager';
  if (user.role) return user.role;
  return user.is_admin ? 'admin' : 'manager';
}

function scopeWhere(req, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const role = getRole(req.user);

  if (role === 'va') {
    return {
      clause: `${prefix}id IN (
        SELECT CAST(resource_id AS INTEGER)
        FROM user_permissions
        WHERE user_id = ? AND resource_type = 'task'
      )`,
      params: [req.user.id],
    };
  }

  if (req.user.is_admin && req.query.scope === 'all') {
    return { clause: '1=1', params: [] };
  }
  return { clause: `${prefix}user_id = ?`, params: [req.user.id] };
}

// ── GET /tasks/grouped ──────────────────────────────
// MUST be registered before /tasks/:id

router.get('/grouped', (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);
    const statuses = ['backlog', 'in_progress', 'review', 'completed'];
    const grouped = {};

    for (const status of statuses) {
      const tasks = db.prepare(`
        SELECT * FROM tasks
        WHERE ${clause} AND status = ?
        ORDER BY
          CASE priority
            WHEN 'critical' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END,
          created_at DESC
        LIMIT 50
      `).all(...params, status);

      grouped[status] = tasks.map(t => ({
        ...t,
        tags: (function(){ try { return JSON.parse(t.tags || '[]'); } catch(e) { return typeof t.tags === 'string' ? t.tags.split(',').map(s=>s.trim()) : []; } })(),
      }));
    }

    res.json(grouped);
  } catch (err) {
    console.error('Grouped tasks error:', err);
    res.status(500).json({ error: 'Failed to fetch grouped tasks' });
  }
});

// ── GET /tasks ──────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { status, priority, source, assignee, search, limit = 50, offset = 0 } = req.query;
    const { clause, params } = scopeWhere(req);

    let query = `SELECT * FROM tasks WHERE ${clause}`;

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    if (priority) {
      query += ' AND priority = ?';
      params.push(priority);
    }
    if (source) {
      query += ' AND source = ?';
      params.push(source);
    }
    if (assignee) {
      query += ' AND assignee = ?';
      params.push(assignee);
    }
    if (search) {
      query += ' AND (title LIKE ? OR description LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const tasks = db.prepare(query).all(...params);

    res.json(
      tasks.map(t => ({ ...t, tags: (function(){ try { return JSON.parse(t.tags || '[]'); } catch(e) { return typeof t.tags === 'string' ? t.tags.split(',').map(s=>s.trim()) : []; } })() }))
    );
  } catch (err) {
    console.error('List tasks error:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// ── GET /tasks/:id ──────────────────────────────────

router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);
    params.push(req.params.id);

    const task = db.prepare(
      `SELECT * FROM tasks WHERE ${clause} AND id = ?`
    ).get(...params);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({ ...task, tags: (function(){ try { return JSON.parse(task.tags || '[]'); } catch(e) { return typeof task.tags === 'string' ? task.tags.split(',').map(s=>s.trim()) : []; } })() });
  } catch (err) {
    console.error('Get task error:', err);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// ── POST /tasks ─────────────────────────────────────

router.post('/', planGate('create_task'), (req, res) => {
  try {
    const db = getDb();
    const {
      title,
      description,
      priority = 'medium',
      source = 'api',
      tags = [],
      eta_minutes,
      assignee = 'Biggelsworth',
    } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const external_id = crypto.randomUUID();

    const result = db.prepare(`
      INSERT INTO tasks (user_id, external_id, title, description, priority, source, tags, eta_minutes, assignee)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      external_id,
      title,
      description || null,
      priority,
      source,
      JSON.stringify(tags),
      eta_minutes || null,
      assignee,
    );

    // Log activity
    db.prepare(`
      INSERT INTO activity_log (user_id, task_id, action, message)
      VALUES (?, ?, 'created', ?)
    `).run(req.user.id, result.lastInsertRowid, `Task created: ${title}`);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ ...task, tags: (function(){ try { return JSON.parse(task.tags || '[]'); } catch(e) { return typeof task.tags === 'string' ? task.tags.split(',').map(s=>s.trim()) : []; } })() });
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// ── PATCH /tasks/:id ────────────────────────────────

router.patch('/:id', planGate('write'), (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    // Verify ownership
    const { clause, params: scopeParams } = scopeWhere(req);
    const existing = db.prepare(
      `SELECT * FROM tasks WHERE ${clause} AND id = ?`
    ).get(...scopeParams, id);

    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    let { status, notes, result_url, priority, tags, eta_minutes, assignee, title, description } = req.body;
    const updates = [];
    const params = [];

    // Normalize status: frontend sends hyphens, DB uses underscores
    if (status) {
      status = status.replace(/-/g, '_');
      updates.push('status = ?');
      params.push(status);
      if (status === 'in_progress' && !existing.started_at) {
        updates.push("started_at = datetime('now')");
      } else if (status === 'completed') {
        updates.push("completed_at = datetime('now')");
      }
    }
    if (title !== undefined)       { updates.push('title = ?');       params.push(title); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (notes !== undefined)       { updates.push('notes = ?');       params.push(notes); }
    if (result_url !== undefined)  { updates.push('result_url = ?');  params.push(result_url); }
    if (priority)                  { updates.push('priority = ?');    params.push(priority); }
    if (tags)                      { updates.push('tags = ?');        params.push(JSON.stringify(tags)); }
    if (eta_minutes !== undefined) { updates.push('eta_minutes = ?'); params.push(eta_minutes); }
    if (assignee !== undefined)    { updates.push('assignee = ?');    params.push(assignee); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // Log status changes
    if (status && status !== existing.status) {
      const messages = {
        in_progress: `Started: ${existing.title}`,
        review: `Ready for review: ${existing.title}`,
        completed: `Completed: ${existing.title}`,
        backlog: `Moved to backlog: ${existing.title}`,
      };
      db.prepare(`
        INSERT INTO activity_log (user_id, task_id, action, message)
        VALUES (?, ?, ?, ?)
      `).run(req.user.id, id, status, messages[status] || `Updated: ${existing.title}`);
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    res.json({ ...task, tags: (function(){ try { return JSON.parse(task.tags || '[]'); } catch(e) { return typeof task.tags === 'string' ? task.tags.split(',').map(s=>s.trim()) : []; } })() });
  } catch (err) {
    console.error('Update task error:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// ── DELETE /tasks/:id ───────────────────────────────

router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const { clause, params } = scopeWhere(req);
    params.push(id);
    const existing = db.prepare(
      `SELECT * FROM tasks WHERE ${clause} AND id = ?`
    ).get(...params);

    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    db.prepare('DELETE FROM activity_log WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

    res.json({ success: true, deleted: existing.title });
  } catch (err) {
    console.error('Delete task error:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

module.exports = router;

