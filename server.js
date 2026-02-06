/**
 * Activity Command Center — Multi-Tenant SaaS API
 *
 * Express.js + better-sqlite3, modular route structure.
 * Backward compatible with existing dashboard + PHP proxy.
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb, closeDb } = require('./db');
const { createTables } = require('./db/schema');
const { authenticate } = require('./middleware/auth');
const { requireAdmin } = require('./middleware/admin');

// ── Initialize database ─────────────────────────────

const db = getDb();
createTables(db);

// ── Express app ─────────────────────────────────────

const app = express();

// ── CORS ────────────────────────────────────────────

const origins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: origins,
  credentials: true,
}));

// ── Request logging ─────────────────────────────────

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ── Stripe webhook (needs raw body — before json parser) ──

const billingRouter = require('./routes/billing');
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  billingRouter
);

// ── JSON body parser (all other routes) ─────────────

app.use(express.json({ limit: '1mb' }));

// ── Public routes (no auth) ─────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    database: 'connected',
  });
});

// Auth (signup + login are public; logout + me check auth internally)
app.use('/auth', require('./routes/auth'));

// ── Protected routes (auth required) ────────────────

app.use(authenticate);

// Tasks
app.use('/tasks', require('./routes/tasks'));

// Events (parser + rules engine + lifecycle)
app.use('/events', require('./routes/events'));

// Activity feed
app.use('/activity', require('./routes/activity'));

// Notifications + Health Score (Empire tier)
app.use('/notifications', require('./routes/notifications'));

// Stats (scoped by user)
app.get('/stats', (req, res) => {
  try {
    const userId = req.user.id;
    const isAdmin = req.user.is_admin && req.query.scope === 'all';
    const userClause = isAdmin ? '1=1' : 'user_id = ?';
    const userParams = isAdmin ? [] : [userId];

    const stats = {
      tasks_today: db.prepare(`
        SELECT COUNT(*) as count FROM tasks
        WHERE ${userClause} AND date(created_at) = date('now')
      `).get(...userParams).count,

      active_projects: db.prepare(`
        SELECT COUNT(*) as count FROM tasks
        WHERE ${userClause} AND status IN ('in_progress', 'review')
      `).get(...userParams).count,

      by_status: {
        backlog: db.prepare(
          `SELECT COUNT(*) as count FROM tasks WHERE ${userClause} AND status = 'backlog'`
        ).get(...userParams).count,
        in_progress: db.prepare(
          `SELECT COUNT(*) as count FROM tasks WHERE ${userClause} AND status = 'in_progress'`
        ).get(...userParams).count,
        review: db.prepare(
          `SELECT COUNT(*) as count FROM tasks WHERE ${userClause} AND status = 'review'`
        ).get(...userParams).count,
        completed_today: db.prepare(`
          SELECT COUNT(*) as count FROM tasks
          WHERE ${userClause} AND status = 'completed'
          AND date(completed_at) = date('now')
        `).get(...userParams).count,
      },

      completed_vs_yesterday: db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM tasks WHERE ${userClause} AND status = 'completed' AND date(completed_at) = date('now')) -
          (SELECT COUNT(*) FROM tasks WHERE ${userClause} AND status = 'completed' AND date(completed_at) = date('now', '-1 day'))
        as diff
      `).get(...userParams, ...userParams).diff,
    };

    res.json(stats);
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// API key management
app.use('/api-keys', require('./routes/apiKeys'));

// Billing (checkout + portal — webhook is mounted above)
app.use('/billing', billingRouter);

// Admin routes (admin-only)
app.use('/admin', requireAdmin, require('./routes/admin'));

// ── 404 catch-all ───────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: 'NotFound',
    message: `${req.method} ${req.path} does not exist`,
  });
});

// ── Global error handler ────────────────────────────

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'InternalError',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message,
  });
});

// ── Start server ────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3050', 10);
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`
┌─────────────────────────────────────────────────────┐
│     Activity Command Center API  v2.0.0             │
│     http://${HOST}:${PORT}                           │
│     Multi-tenant SaaS mode                          │
└─────────────────────────────────────────────────────┘
  `);
});

// ── Graceful shutdown ───────────────────────────────

function shutdown() {
  console.log('Shutting down...');
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
