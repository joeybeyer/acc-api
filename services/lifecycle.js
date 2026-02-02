/**
 * Task Lifecycle Automation (Task #102)
 *
 * Handles:
 *   1. Auto-status updates when completion signals are detected
 *   2. Zombie task detection (stale in_progress tasks)
 *   3. Activity logging for all lifecycle transitions
 *   4. Periodic audit reconciliation
 *
 * Called by the events route after the rules engine produces actions.
 */

const { getDb } = require('../db');

// ── Execute Status Update ───────────────────────────────

/**
 * Update one or more tasks' status based on a parsed event.
 *
 * @param {number[]} taskIds     — Task IDs to update
 * @param {string} targetStatus  — New status (completed, in_progress, review, backlog)
 * @param {number} userId        — User who owns the tasks
 * @param {Object} meta          — Event metadata for logging
 * @returns {Object} { updated: [], skipped: [], errors: [] }
 */
function updateTaskStatus(taskIds, targetStatus, userId, meta = {}) {
  const db = getDb();
  const results = { updated: [], skipped: [], errors: [] };

  const validStatuses = ['backlog', 'in_progress', 'review', 'completed'];
  if (!validStatuses.includes(targetStatus)) {
    results.errors.push({ error: `Invalid status: ${targetStatus}` });
    return results;
  }

  for (const taskId of taskIds) {
    try {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId);

      if (!task) {
        results.skipped.push({ id: taskId, reason: 'not_found' });
        continue;
      }

      if (task.status === targetStatus) {
        results.skipped.push({ id: taskId, reason: 'already_in_status', status: targetStatus });
        continue;
      }

      // Build update
      const updates = ['status = ?', "updated_at = datetime('now')"];
      const params = [targetStatus];

      if (targetStatus === 'in_progress' && !task.started_at) {
        updates.push("started_at = datetime('now')");
      }
      if (targetStatus === 'completed') {
        updates.push("completed_at = datetime('now')");
      }

      params.push(taskId);
      db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      // Log activity
      const message = meta.trigger === 'auto'
        ? `Auto-${targetStatus}: ${task.title} (detected from message)`
        : `${targetStatus}: ${task.title}`;

      db.prepare(`
        INSERT INTO activity_log (user_id, task_id, action, message, metadata)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        userId,
        taskId,
        targetStatus,
        message,
        JSON.stringify({
          previous_status: task.status,
          trigger: meta.trigger || 'manual',
          source: meta.source || 'api',
          event_id: meta.event_id || null,
        }),
      );

      results.updated.push({
        id: taskId,
        title: task.title,
        from: task.status,
        to: targetStatus,
      });
    } catch (err) {
      results.errors.push({ id: taskId, error: err.message });
    }
  }

  return results;
}

// ── Zombie Task Detection ───────────────────────────────

/**
 * Find tasks that have been in_progress for too long without updates.
 *
 * @param {number} userId          — User to audit
 * @param {number} staleDays       — Days without update to consider stale (default: 7)
 * @returns {Array} stale tasks
 */
function findZombieTasks(userId, staleDays = 7) {
  const db = getDb();

  const zombies = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ?
      AND status = 'in_progress'
      AND updated_at < datetime('now', ? || ' days')
    ORDER BY updated_at ASC
  `).all(userId, `-${staleDays}`);

  return zombies.map(t => ({
    ...t,
    tags: JSON.parse(t.tags || '[]'),
    days_stale: Math.floor(
      (Date.now() - new Date(t.updated_at + 'Z').getTime()) / (1000 * 60 * 60 * 24)
    ),
  }));
}

// ── Audit: Reconcile Task States ────────────────────────

/**
 * Run a full audit of task states for a user.
 * Returns a report of potential issues.
 *
 * @param {number} userId
 * @returns {Object} audit report
 */
function auditTasks(userId) {
  const db = getDb();

  const report = {
    timestamp: new Date().toISOString(),
    userId,
    issues: [],
    stats: {},
  };

  // Count by status
  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as count FROM tasks
    WHERE user_id = ?
    GROUP BY status
  `).all(userId);

  report.stats.by_status = {};
  for (const row of statusCounts) {
    report.stats.by_status[row.status] = row.count;
  }

  // Zombie tasks (in_progress > 7 days)
  const zombies = findZombieTasks(userId, 7);
  if (zombies.length > 0) {
    report.issues.push({
      type: 'zombie_tasks',
      severity: 'medium',
      count: zombies.length,
      tasks: zombies.map(z => ({ id: z.id, title: z.title, days_stale: z.days_stale })),
      suggestion: `${zombies.length} task(s) have been in_progress for 7+ days. Review and either complete or move to backlog.`,
    });
  }

  // Ancient backlog (backlog > 30 days)
  const ancientBacklog = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ?
      AND status = 'backlog'
      AND created_at < datetime('now', '-30 days')
    ORDER BY created_at ASC
  `).all(userId);

  if (ancientBacklog.length > 0) {
    report.issues.push({
      type: 'ancient_backlog',
      severity: 'low',
      count: ancientBacklog.length,
      tasks: ancientBacklog.map(t => ({ id: t.id, title: t.title })),
      suggestion: `${ancientBacklog.length} task(s) have been in backlog for 30+ days. Consider archiving or deleting.`,
    });
  }

  // Tasks completed today
  report.stats.completed_today = db.prepare(`
    SELECT COUNT(*) as count FROM tasks
    WHERE user_id = ? AND status = 'completed' AND date(completed_at) = date('now')
  `).get(userId).count;

  // Tasks created today
  report.stats.created_today = db.prepare(`
    SELECT COUNT(*) as count FROM tasks
    WHERE user_id = ? AND date(created_at) = date('now')
  `).get(userId).count;

  report.stats.total_issues = report.issues.length;

  return report;
}

// ── Fuzzy Task Matching ─────────────────────────────────

/**
 * Search for tasks that might match a completion signal
 * when no explicit task ID was provided.
 *
 * @param {number} userId
 * @param {Object} hints — { niches, tools, markets, query }
 * @returns {Array} potential matches
 */
function fuzzyMatchTasks(userId, hints) {
  const db = getDb();
  const candidates = [];

  // Search active tasks (in_progress, review) by keyword
  if (hints.query) {
    const words = hints.query.split(/\s+/).filter(w => w.length > 3);
    for (const word of words.slice(0, 5)) {  // Limit to 5 keywords
      const matches = db.prepare(`
        SELECT * FROM tasks
        WHERE user_id = ?
          AND status IN ('in_progress', 'review')
          AND (title LIKE ? OR description LIKE ?)
        LIMIT 5
      `).all(userId, `%${word}%`, `%${word}%`);

      for (const m of matches) {
        if (!candidates.find(c => c.id === m.id)) {
          candidates.push({ ...m, tags: JSON.parse(m.tags || '[]'), match_word: word });
        }
      }
    }
  }

  // Score candidates by relevance
  return candidates.map(c => {
    let score = 0.5;  // Base score for keyword match

    // Boost if niche matches a tag
    if (hints.niches) {
      for (const n of hints.niches) {
        if (c.tags.includes(`niche:${n}`) || c.title.toLowerCase().includes(n)) score += 0.2;
      }
    }

    // Boost if tool matches
    if (hints.tools) {
      for (const t of hints.tools) {
        if (c.title.toLowerCase().includes(t.toLowerCase())) score += 0.15;
      }
    }

    return { ...c, relevance: Math.min(score, 1.0) };
  }).sort((a, b) => b.relevance - a.relevance);
}

module.exports = {
  updateTaskStatus,
  findZombieTasks,
  auditTasks,
  fuzzyMatchTasks,
};
