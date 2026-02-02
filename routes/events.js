/**
 * Events Route — Universal event ingestion endpoint.
 *
 * POST /events/ingest   — Receive a raw message, parse it, apply rules, execute actions
 * POST /events/batch    — Process multiple messages at once
 * GET  /events/audit    — Run a lifecycle audit on the user's tasks
 * GET  /events/zombies  — List stale in_progress tasks
 * POST /events/parse    — Parse only (dry run, no side effects)
 *
 * This is the front door for the intelligence layer.
 * Telegram messages, webhook events, rank alerts — everything comes through here.
 */

const { Router } = require('express');
const { process: processEvent } = require('../services/rules');
const { updateTaskStatus, auditTasks, findZombieTasks, fuzzyMatchTasks } = require('../services/lifecycle');
const { getDb } = require('../db');

const router = Router();

// ── POST /events/ingest ─────────────────────────────────

router.post('/ingest', async (req, res) => {
  try {
    const { text, source, sender, channel, dry_run } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    // Run through parser + rules engine
    const event = processEvent(text, { source, sender, channel });

    // If dry run, return the parsed event without executing
    if (dry_run) {
      return res.json({ event, executed: false });
    }

    // Execute actions
    const executed = [];

    for (const action of event.actions) {
      switch (action.type) {
        case 'create_task': {
          if (action.confidence < 0.6) {
            executed.push({ type: action.type, status: 'skipped', reason: 'low_confidence', confidence: action.confidence });
            break;
          }
          const db = getDb();
          const crypto = require('crypto');
          const taskData = action.data;

          const result = db.prepare(`
            INSERT INTO tasks (user_id, external_id, title, description, priority, source, tags, assignee)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            req.user.id,
            crypto.randomUUID(),
            taskData.title,
            taskData.description || null,
            taskData.priority || 'medium',
            taskData.source || source || 'event',
            JSON.stringify(taskData.tags || []),
            'Biggelsworth',
          );

          // Log activity
          db.prepare(`
            INSERT INTO activity_log (user_id, task_id, action, message, metadata)
            VALUES (?, ?, 'created', ?, ?)
          `).run(
            req.user.id,
            result.lastInsertRowid,
            `Auto-created: ${taskData.title}`,
            JSON.stringify({ trigger: 'event_parser', source }),
          );

          const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
          executed.push({
            type: action.type,
            status: 'executed',
            task: { ...task, tags: JSON.parse(task.tags || '[]') },
          });
          break;
        }

        case 'update_task_status': {
          const result = updateTaskStatus(
            action.data.taskIds,
            action.data.status,
            req.user.id,
            { trigger: 'auto', source: source || 'event' },
          );
          executed.push({ type: action.type, status: 'executed', result });
          break;
        }

        case 'fuzzy_status_update': {
          const matches = fuzzyMatchTasks(req.user.id, action.data.searchHints);
          if (matches.length > 0 && matches[0].relevance >= 0.7) {
            // Auto-update if high confidence
            const result = updateTaskStatus(
              [matches[0].id],
              action.data.targetStatus,
              req.user.id,
              { trigger: 'auto_fuzzy', source: source || 'event' },
            );
            executed.push({ type: action.type, status: 'executed', result, matched_task: matches[0].title });
          } else {
            // Return candidates for human confirmation
            executed.push({
              type: action.type,
              status: 'needs_confirmation',
              candidates: matches.slice(0, 3).map(m => ({
                id: m.id,
                title: m.title,
                status: m.status,
                relevance: m.relevance,
              })),
            });
          }
          break;
        }

        case 'search_tasks': {
          const db = getDb();
          let tasks;
          if (action.data.taskIds) {
            const placeholders = action.data.taskIds.map(() => '?').join(',');
            tasks = db.prepare(
              `SELECT * FROM tasks WHERE user_id = ? AND id IN (${placeholders}) ORDER BY id`
            ).all(req.user.id, ...action.data.taskIds);
          } else {
            tasks = db.prepare(`
              SELECT * FROM tasks WHERE user_id = ?
              AND (title LIKE ? OR description LIKE ?)
              ORDER BY updated_at DESC LIMIT 10
            `).all(req.user.id, `%${action.data.query}%`, `%${action.data.query}%`);
          }
          executed.push({
            type: action.type,
            status: 'executed',
            tasks: tasks.map(t => ({ ...t, tags: JSON.parse(t.tags || '[]') })),
          });
          break;
        }

        default:
          executed.push({ type: action.type, status: 'unsupported' });
      }
    }

    // Log the event
    const db = getDb();
    try {
      db.prepare(`
        INSERT INTO events (user_id, raw_text, intent, confidence, urgency, entities, actions_taken, source, sender, channel)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.user.id,
        text,
        event.intent,
        event.confidence,
        event.urgency,
        JSON.stringify(event.entities),
        JSON.stringify(executed),
        source || null,
        sender || null,
        channel || null,
      );
    } catch (e) {
      // Events table might not exist yet — non-critical
      console.warn('Event logging failed (table may not exist):', e.message);
    }

    res.json({ event, executed });
  } catch (err) {
    console.error('Event ingest error:', err);
    res.status(500).json({ error: 'Failed to process event' });
  }
});

// ── POST /events/batch ──────────────────────────────────

router.post('/batch', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }

    const results = [];
    for (const msg of messages.slice(0, 50)) {  // Cap at 50
      const event = processEvent(msg.text, {
        source: msg.source,
        sender: msg.sender,
        channel: msg.channel,
      });
      results.push({ text: msg.text, event });
    }

    res.json({ count: results.length, results });
  } catch (err) {
    console.error('Batch process error:', err);
    res.status(500).json({ error: 'Failed to process batch' });
  }
});

// ── POST /events/parse (dry run) ────────────────────────

router.post('/parse', (req, res) => {
  try {
    const { text, source, sender, channel } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    const event = processEvent(text, { source, sender, channel });
    res.json({ event });
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse' });
  }
});

// ── GET /events/audit ───────────────────────────────────

router.get('/audit', (req, res) => {
  try {
    const report = auditTasks(req.user.id);
    res.json(report);
  } catch (err) {
    console.error('Audit error:', err);
    res.status(500).json({ error: 'Failed to run audit' });
  }
});

// ── GET /events/zombies ─────────────────────────────────

router.get('/zombies', (req, res) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const zombies = findZombieTasks(req.user.id, days);
    res.json({ count: zombies.length, staleDays: days, tasks: zombies });
  } catch (err) {
    console.error('Zombies error:', err);
    res.status(500).json({ error: 'Failed to find zombie tasks' });
  }
});

module.exports = router;
