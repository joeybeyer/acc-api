/**
 * Admin routes — platform management.
 * All routes require is_admin=1 (enforced by middleware stack in server.js).
 */
const { Router } = require('express');
const { getDb } = require('../db');

const router = Router();

// ── GET /admin/users ────────────────────────────────

router.get('/users', (req, res) => {
  try {
    const db = getDb();
    const { limit = 50, offset = 0, plan, active } = req.query;

    let query = `
      SELECT
        u.id, u.email, u.name, u.company, u.plan,
        u.is_admin, u.is_active, u.trial_ends_at,
        u.stripe_customer_id, u.stripe_subscription_id,
        u.created_at, u.updated_at,
        (SELECT COUNT(*) FROM tasks WHERE user_id = u.id) as task_count,
        (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id) as api_key_count
      FROM users u
      WHERE 1=1
    `;
    const params = [];

    if (plan) {
      query += ' AND u.plan = ?';
      params.push(plan);
    }
    if (active !== undefined) {
      query += ' AND u.is_active = ?';
      params.push(active === 'true' ? 1 : 0);
    }

    query += ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const users = db.prepare(query).all(...params);

    // Total count for pagination
    const total = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;

    res.json({ users, total });
  } catch (err) {
    console.error('Admin list users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ── GET /admin/users/:id ────────────────────────────

router.get('/users/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const user = db.prepare(`
      SELECT id, email, name, company, plan, is_admin, is_active,
             trial_ends_at, stripe_customer_id, stripe_subscription_id,
             created_at, updated_at
      FROM users WHERE id = ?
    `).get(id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Task stats
    const taskStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'backlog' THEN 1 ELSE 0 END) as backlog,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as review,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN created_at >= datetime('now', 'start of month') THEN 1 ELSE 0 END) as this_month
      FROM tasks WHERE user_id = ?
    `).get(id);

    // API keys
    const apiKeys = db.prepare(`
      SELECT id, key_prefix, name, last_used_at, created_at
      FROM api_keys WHERE user_id = ?
    `).all(id);

    // Recent activity
    const recentActivity = db.prepare(`
      SELECT * FROM activity_log
      WHERE user_id = ?
      ORDER BY timestamp DESC LIMIT 10
    `).all(id);

    res.json({
      user,
      tasks: taskStats,
      api_keys: apiKeys,
      recent_activity: recentActivity.map(a => ({
        ...a,
        metadata: JSON.parse(a.metadata || '{}'),
      })),
    });
  } catch (err) {
    console.error('Admin get user error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── PATCH /admin/users/:id ──────────────────────────

router.patch('/users/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { is_active, plan, is_admin } = req.body;

    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updates = [];
    const params = [];

    if (is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(is_active ? 1 : 0);
    }
    if (plan) {
      updates.push('plan = ?');
      params.push(plan);
    }
    if (is_admin !== undefined) {
      updates.push('is_admin = ?');
      params.push(is_admin ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const user = db.prepare(`
      SELECT id, email, name, company, plan, is_admin, is_active,
             trial_ends_at, stripe_customer_id, created_at, updated_at
      FROM users WHERE id = ?
    `).get(id);

    res.json(user);
  } catch (err) {
    console.error('Admin update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ── GET /admin/stats ────────────────────────────────

router.get('/stats', (req, res) => {
  try {
    const db = getDb();

    const users = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN created_at >= datetime('now', 'start of month') THEN 1 ELSE 0 END) as new_this_month,
        SUM(CASE WHEN plan = 'starter' THEN 1 ELSE 0 END) as starter,
        SUM(CASE WHEN plan = 'pro' THEN 1 ELSE 0 END) as pro,
        SUM(CASE WHEN plan = 'agency' THEN 1 ELSE 0 END) as agency,
        SUM(CASE WHEN trial_ends_at > datetime('now') AND stripe_subscription_id IS NULL THEN 1 ELSE 0 END) as on_trial
      FROM users
    `).get();

    const tasks = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN created_at >= datetime('now', 'start of month') THEN 1 ELSE 0 END) as created_this_month,
        SUM(CASE WHEN status = 'completed' AND completed_at >= datetime('now', 'start of month') THEN 1 ELSE 0 END) as completed_this_month
      FROM tasks
    `).get();

    // Revenue estimate (based on active subscriptions)
    const revenue = db.prepare(`
      SELECT
        SUM(CASE plan WHEN 'starter' THEN 49 WHEN 'pro' THEN 149 WHEN 'agency' THEN 499 ELSE 0 END) as mrr
      FROM users
      WHERE stripe_subscription_id IS NOT NULL AND is_active = 1
    `).get();

    res.json({
      users,
      tasks,
      revenue: {
        mrr: revenue.mrr || 0,
        currency: 'usd',
      },
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
