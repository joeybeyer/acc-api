const express = require('express');
const router = express.Router();
const db = require('../db');

// ===========================================
// HEALTH SCORE ALGORITHM
// ===========================================
// Portfolio Health Score (0-100)
// ├── GMB Health (40%)      - suspensions, verification, NAP
// ├── Review Velocity (25%) - 30-day count, rating trend
// ├── Task Queue (20%)      - stale ratio, completion rate
// └── Uptime (15%)          - site availability, API health

async function calculateHealthScore(userId) {
  const scores = {
    gmb: { score: 100, weight: 0.40, details: {} },
    reviews: { score: 100, weight: 0.25, details: {} },
    tasks: { score: 100, weight: 0.20, details: {} },
    uptime: { score: 100, weight: 0.15, details: {} }
  };

  try {
    // GMB Health (40%)
    const gmbStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) as suspended,
        SUM(CASE WHEN status = 'verified' OR status = 'live' THEN 1 ELSE 0 END) as verified,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM gmb_listings
      WHERE user_id = ?
    `).get(userId) || { total: 0, suspended: 0, verified: 0, pending: 0 };

    if (gmbStats.total > 0) {
      const suspensionPenalty = (gmbStats.suspended / gmbStats.total) * 50;
      const verificationBonus = (gmbStats.verified / gmbStats.total) * 50;
      scores.gmb.score = Math.max(0, Math.min(100, 50 + verificationBonus - suspensionPenalty));
      scores.gmb.details = {
        total: gmbStats.total,
        suspended: gmbStats.suspended,
        verified: gmbStats.verified,
        pending: gmbStats.pending
      };
    }

    // Review Velocity (25%)
    const reviewStats = db.prepare(`
      SELECT 
        AVG(review_count) as avg_reviews,
        AVG(rating) as avg_rating,
        COUNT(*) as listings_with_reviews
      FROM gmb_listings
      WHERE user_id = ? AND review_count > 0
    `).get(userId) || { avg_reviews: 0, avg_rating: 0 };

    const ratingScore = (reviewStats.avg_rating || 0) / 5 * 60;
    const velocityScore = Math.min(40, (reviewStats.avg_reviews || 0) / 50 * 40);
    scores.reviews.score = Math.min(100, ratingScore + velocityScore);
    scores.reviews.details = {
      avgRating: Math.round((reviewStats.avg_rating || 0) * 10) / 10,
      avgReviews: Math.round(reviewStats.avg_reviews || 0)
    };

    // Task Queue Health (20%)
    const taskStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'in_progress' AND 
            datetime(updated_at) < datetime('now', '-7 days') THEN 1 ELSE 0 END) as stale
      FROM tasks
      WHERE user_id = ?
    `).get(userId) || { total: 0, completed: 0, stale: 0 };

    if (taskStats.total > 0) {
      const completionRate = (taskStats.completed / taskStats.total) * 70;
      const stalePenalty = (taskStats.stale / taskStats.total) * 30;
      scores.tasks.score = Math.max(0, Math.min(100, completionRate + 30 - stalePenalty));
      scores.tasks.details = {
        total: taskStats.total,
        completed: taskStats.completed,
        stale: taskStats.stale,
        completionRate: Math.round((taskStats.completed / taskStats.total) * 100)
      };
    }

    // Uptime (15%) - simplified, assume good unless we track otherwise
    scores.uptime.score = 95; // Default high, would integrate with monitoring
    scores.uptime.details = { status: 'healthy' };

  } catch (err) {
    console.error('Health score calculation error:', err);
  }

  // Calculate weighted total
  const totalScore = Math.round(
    scores.gmb.score * scores.gmb.weight +
    scores.reviews.score * scores.reviews.weight +
    scores.tasks.score * scores.tasks.weight +
    scores.uptime.score * scores.uptime.weight
  );

  return {
    score: totalScore,
    grade: totalScore >= 90 ? 'A' : totalScore >= 80 ? 'B' : totalScore >= 70 ? 'C' : totalScore >= 60 ? 'D' : 'F',
    breakdown: scores,
    calculatedAt: new Date().toISOString()
  };
}

// ===========================================
// NOTIFICATIONS TABLE (create if not exists)
// ===========================================
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    category TEXT DEFAULT 'info',
    title TEXT NOT NULL,
    message TEXT,
    niche TEXT,
    market TEXT,
    gmb_id INTEGER,
    is_read INTEGER DEFAULT 0,
    is_actioned INTEGER DEFAULT 0,
    action_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// ===========================================
// ROUTES
// ===========================================

// GET /api/notifications/health - Portfolio health score
router.get('/health', async (req, res) => {
  try {
    const userId = req.user?.id || 1; // Default to admin for now
    const health = await calculateHealthScore(userId);
    res.json(health);
  } catch (err) {
    console.error('Health score error:', err);
    res.status(500).json({ error: 'Failed to calculate health score' });
  }
});

// GET /api/notifications - List notifications
router.get('/', (req, res) => {
  try {
    const userId = req.user?.id || 1;
    const limit = parseInt(req.query.limit) || 50;
    const unreadOnly = req.query.unread === 'true';

    let query = `
      SELECT * FROM notifications 
      WHERE user_id = ?
      ${unreadOnly ? 'AND is_read = 0' : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `;

    const notifications = db.prepare(query).all(userId, limit);
    const unreadCount = db.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0'
    ).get(userId);

    res.json({
      notifications,
      unreadCount: unreadCount?.count || 0
    });
  } catch (err) {
    console.error('Notifications error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// POST /api/notifications - Create notification (internal/webhook use)
router.post('/', (req, res) => {
  try {
    const { user_id, type, category, title, message, niche, market, gmb_id, action_url } = req.body;

    const result = db.prepare(`
      INSERT INTO notifications (user_id, type, category, title, message, niche, market, gmb_id, action_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user_id || 1, type, category || 'info', title, message, niche, market, gmb_id, action_url);

    res.json({ id: result.lastInsertRowid, success: true });
  } catch (err) {
    console.error('Create notification error:', err);
    res.status(500).json({ error: 'Failed to create notification' });
  }
});

// PATCH /api/notifications/:id/read - Mark as read
router.patch('/:id/read', (req, res) => {
  try {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// PATCH /api/notifications/read-all - Mark all as read
router.patch('/read-all', (req, res) => {
  try {
    const userId = req.user?.id || 1;
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

// DELETE /api/notifications/:id - Delete notification
router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM notifications WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

module.exports = router;
