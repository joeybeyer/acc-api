/**
 * Webhook routes for ACC SaaS
 * 
 * Receives external webhook payloads and creates tasks.
 * Authentication via query parameter API keys.
 */
const express = require('express');
const crypto = require('crypto');
// rate-limit handled at server.js level
const { getDb } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ─────────────────────────────────────────

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function sanitizeUser(row) {
  if (!row) return null;
  const user = { ...row };
  delete user.password_hash;
  return user;
}

// ── Webhook-specific API key auth ─────────────────

function authenticateWebhook(req, res, next) {
  const db = getDb();
  const apiKey = req.query.key;
  
  if (!apiKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API key required via ?key= query parameter'
    });
  }

  const keyHash = hashApiKey(apiKey);
  const keyRow = db.prepare(
    'SELECT * FROM api_keys WHERE key_hash = ?'
  ).get(keyHash);

  if (!keyRow) {
    return res.status(401).json({
      error: 'Unauthorized', 
      message: 'Invalid API key'
    });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE id = ? AND is_active = 1'
  ).get(keyRow.user_id);

  if (!user) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'User account is not active'
    });
  }

  // Update last_used_at (fire-and-forget)
  db.prepare(
    `UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`
  ).run(keyRow.id);

  req.user = sanitizeUser(user);
  next();
}

// Webhook rate limiting removed — Telegram sends low volume
// and the global apiRateLimit in server.js covers abuse

// ── Text parsing helpers ───────────────────────────

function extractTitle(text) {
  if (!text) return 'Untitled Task';
  
  // First sentence or first 80 chars, whichever is shorter
  const sentences = text.split(/[.!?\n]/);
  const firstSentence = sentences[0].trim();
  
  if (firstSentence.length <= 80) {
    return firstSentence || 'Untitled Task';
  } else {
    return text.substring(0, 80).trim() + '...';
  }
}

function detectPriority(text) {
  if (!text) return 'medium';
  
  const lowercaseText = text.toLowerCase();
  const urgentKeywords = ['urgent', 'asap', 'today', 'emergency'];
  
  return urgentKeywords.some(keyword => lowercaseText.includes(keyword)) ? 'high' : 'medium';
}

function extractTags(text) {
  if (!text) return '';
  
  const lowercaseText = text.toLowerCase();
  const tags = [];
  
  if (lowercaseText.includes('gbp') || lowercaseText.includes('gmb')) {
    tags.push('gmb');
  }
  if (lowercaseText.includes('rank') || lowercaseText.includes('ranking')) {
    tags.push('seo');
  }
  if (lowercaseText.includes('call') || lowercaseText.includes('phone')) {
    tags.push('calls');
  }
  if (lowercaseText.includes('site') || lowercaseText.includes('website') || lowercaseText.includes('deploy')) {
    tags.push('sites');
  }
  if (lowercaseText.includes('schema')) {
    tags.push('schema');
  }
  
  return tags.join(',');
}

// ── Routes ─────────────────────────────────────────

/**
 * POST /webhooks/telegram
 * Receives Telegram Bot API webhook updates
 */
router.post('/telegram', authenticateWebhook, (req, res) => {
  const db = getDb();
  
  try {
    const payload = req.body;
    
    // Ignore non-text updates (photos, stickers, etc.)
    if (!payload.message || !payload.message.text) {
      return res.status(200).json({ success: true, message: 'Non-text update ignored' });
    }
    
    const message = payload.message;
    const text = message.text.trim();
    const sender = message.from;

    // Filter out non-task messages
    // Skip: commands, very short messages, greetings, chatter
    if (text.startsWith('/')) {
      return res.status(200).json({ success: true, message: 'Command ignored' });
    }
    if (text.length < 10) {
      return res.status(200).json({ success: true, message: 'Too short for task' });
    }
    const skipPatterns = /^(hi|hey|hello|ok|okay|yes|no|yeah|nah|sure|thanks|thank you|lol|lmao|haha|👍|🙏|nice|cool|good|great|yep|nope|sup|yo|brb|gtg|gm|gn)\b/i;
    if (skipPatterns.test(text)) {
      return res.status(200).json({ success: true, message: 'Casual message ignored' });
    }
    const chat = message.chat;
    const timestamp = new Date(message.date * 1000).toISOString();
    
    // Extract task data
    const title = extractTitle(text);
    const priority = detectPriority(text);
    const tags = extractTags(text);
    const assignee = sender.first_name || sender.username || 'Unknown';
    
    // Dedup: skip if identical title created in last 60 seconds for this user
    const recent = db.prepare(
      `SELECT id FROM tasks WHERE user_id = ? AND title = ? AND created_at > datetime('now', '-60 seconds')`
    ).get(req.user.id, title);
    if (recent) {
      return res.json({ success: true, task_id: recent.id, deduplicated: true });
    }

    // Create task
    const insertTask = db.prepare(`
      INSERT INTO tasks (
        title, description, status, priority, source, tags, assignee, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = insertTask.run(
      title,
      text,
      'backlog',
      priority,
      'telegram',
      tags,
      assignee,
      req.user.id
    );
    
    const taskId = result.lastInsertRowid;
    
    // Create activity log entry
    const insertActivity = db.prepare(`
      INSERT INTO activity_log (task_id, action, message, user_id)
      VALUES (?, ?, ?, ?)
    `);
    
    insertActivity.run(
      taskId,
      'created',
      `Task from Telegram: ${title}`,
      req.user.id
    );
    
    // Log webhook event
    try {
      db.prepare(`
        INSERT INTO webhook_events (user_id, source, raw_payload, parsed_title, parsed_priority, parsed_tags, task_id, sender_name, sender_username, chat_title, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.user.id, 'telegram', JSON.stringify(req.body),
        title, priority, tags, taskId,
        sender.first_name || '', sender.username || '',
        chat.title || 'Direct Message', 'success'
      );
    } catch(e) { console.warn('Event log failed:', e); }

    return res.status(200).json({
      success: true,
      task_id: taskId
    });
    
  } catch (error) {
    console.error('Telegram webhook error:', error);
    
    // Always return 200 to prevent Telegram retries
    return res.status(200).json({
      success: false,
      error: 'Internal processing error'
    });
  }
});

/**
 * GET /webhooks/telegram/status
 * Check connection status for onboarding wizard
 */
router.get('/telegram/status', authenticate, (req, res) => {
  const db = getDb();
  
  try {
    // Check activity log for tasks with source="telegram" for this user
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_messages,
        MAX(timestamp) as last_message_at
      FROM activity_log 
      WHERE user_id = ? 
        AND action = 'created'
        AND message LIKE 'Task from Telegram:%'
    `).get(req.user.id);
    
    const connected = stats.total_messages > 0;
    
    return res.json({
      connected: connected,
      last_message_at: stats.last_message_at,
      total_messages: stats.total_messages
    });
    
  } catch (error) {
    console.error('Telegram status error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to check webhook status'
    });
  }
});

/**
 * POST /webhooks/whatsapp
 * Receives WhatsApp Business API (Meta Cloud API) webhook updates
 * Also supports Twilio WhatsApp format
 */
router.post('/whatsapp', authenticateWebhook, (req, res) => {
  const db = getDb();
  
  try {
    const payload = req.body;
    let text, senderName, senderPhone, chatTitle;

    // Meta Cloud API format (official WhatsApp Business)
    if (payload.entry && payload.entry[0]) {
      const entry = payload.entry[0];
      const changes = entry.changes && entry.changes[0];
      const value = changes && changes.value;
      const msg = value && value.messages && value.messages[0];
      
      if (!msg || msg.type !== 'text') {
        return res.status(200).json({ success: true, message: 'Non-text update ignored' });
      }
      
      text = msg.text && msg.text.body;
      senderPhone = msg.from || '';
      // Try to get contact name
      const contact = value.contacts && value.contacts[0];
      senderName = contact ? (contact.profile && contact.profile.name) || contact.wa_id : senderPhone;
      chatTitle = 'WhatsApp';
    }
    // Twilio WhatsApp format
    else if (payload.Body && (payload.From || '').includes('whatsapp:')) {
      text = payload.Body;
      senderPhone = (payload.From || '').replace('whatsapp:', '');
      senderName = payload.ProfileName || senderPhone;
      chatTitle = 'WhatsApp (Twilio)';
    }
    // Simple/generic format (for testing)
    else if (payload.message && payload.message.text) {
      text = payload.message.text;
      senderName = payload.message.from || 'Unknown';
      senderPhone = payload.message.phone || '';
      chatTitle = 'WhatsApp';
    }
    else {
      return res.status(200).json({ success: true, message: 'Unrecognized payload format' });
    }

    if (!text || !text.trim()) {
      return res.status(200).json({ success: true, message: 'Empty message ignored' });
    }

    text = text.trim();

    // Same filters as Telegram
    if (text.startsWith('/')) {
      return res.status(200).json({ success: true, message: 'Command ignored' });
    }
    if (text.length < 10) {
      return res.status(200).json({ success: true, message: 'Too short for task' });
    }
    const skipPatterns = /^(hi|hey|hello|ok|okay|yes|no|yeah|nah|sure|thanks|thank you|lol|lmao|haha|👍|🙏|nice|cool|good|great|yep|nope|sup|yo|brb|gtg|gm|gn)\b/i;
    if (skipPatterns.test(text)) {
      return res.status(200).json({ success: true, message: 'Casual message ignored' });
    }

    const title = extractTitle(text);
    const priority = detectPriority(text);
    const tags = extractTags(text);

    // Dedup
    const recent = db.prepare(
      `SELECT id FROM tasks WHERE user_id = ? AND title = ? AND created_at > datetime('now', '-60 seconds')`
    ).get(req.user.id, title);
    if (recent) {
      return res.json({ success: true, task_id: recent.id, deduplicated: true });
    }

    const result = db.prepare(`
      INSERT INTO tasks (title, description, status, priority, source, tags, assignee, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, text, 'backlog', priority, 'whatsapp', tags, senderName, req.user.id);

    const taskId = result.lastInsertRowid;

    db.prepare(`
      INSERT INTO activity_log (task_id, action, message, user_id)
      VALUES (?, ?, ?, ?)
    `).run(taskId, 'created', `Task from WhatsApp: ${title}`, req.user.id);

    // Log webhook event
    try {
      db.prepare(`
        INSERT INTO webhook_events (user_id, source, raw_payload, parsed_title, parsed_priority, parsed_tags, task_id, sender_name, sender_username, chat_title, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, 'whatsapp', JSON.stringify(req.body), title, priority, tags, taskId, senderName, senderPhone, chatTitle, 'success');
    } catch(e) { console.warn('Event log failed:', e); }

    return res.status(200).json({ success: true, task_id: taskId });

  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    return res.status(200).json({ success: false, error: 'Internal processing error' });
  }
});

// WhatsApp webhook verification (Meta requires GET for setup)
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  // For Meta webhook verification
  if (mode === 'subscribe' && token === req.query.key) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'Verification failed' });
});

/**
 * POST /webhooks/email
 * Receives forwarded emails (SendGrid Inbound Parse, Mailgun, etc.)
 */
router.post('/email', authenticateWebhook, (req, res) => {
  const db = getDb();
  
  try {
    const payload = req.body;
    let subject, body, fromEmail, fromName;

    // SendGrid Inbound Parse format
    if (payload.subject || payload.text || payload.html) {
      subject = payload.subject || '';
      body = payload.text || payload.html || '';
      fromEmail = payload.from || payload.sender || '';
      fromName = payload.from_name || fromEmail;
    }
    // Mailgun format
    else if (payload.Subject || payload['body-plain']) {
      subject = payload.Subject || '';
      body = payload['body-plain'] || payload['stripped-text'] || '';
      fromEmail = payload.sender || payload.from || '';
      fromName = payload.from || fromEmail;
    }
    // Generic
    else if (payload.email) {
      subject = payload.email.subject || '';
      body = payload.email.body || payload.email.text || '';
      fromEmail = payload.email.from || '';
      fromName = payload.email.from_name || fromEmail;
    }
    else {
      return res.status(200).json({ success: true, message: 'Unrecognized email format' });
    }

    const text = subject || body.substring(0, 200);
    if (!text || text.trim().length < 5) {
      return res.status(200).json({ success: true, message: 'Empty email ignored' });
    }

    const title = extractTitle(subject || body);
    const priority = detectPriority(subject + ' ' + body);
    const tags = extractTags(subject + ' ' + body);

    // Dedup
    const recent = db.prepare(
      `SELECT id FROM tasks WHERE user_id = ? AND title = ? AND created_at > datetime('now', '-60 seconds')`
    ).get(req.user.id, title);
    if (recent) {
      return res.json({ success: true, task_id: recent.id, deduplicated: true });
    }

    const result = db.prepare(`
      INSERT INTO tasks (title, description, status, priority, source, tags, assignee, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, body.substring(0, 2000), 'backlog', priority, 'email', tags, fromName, req.user.id);

    const taskId = result.lastInsertRowid;

    db.prepare(`
      INSERT INTO activity_log (task_id, action, message, user_id)
      VALUES (?, ?, ?, ?)
    `).run(taskId, 'created', `Task from Email: ${title}`, req.user.id);

    try {
      db.prepare(`
        INSERT INTO webhook_events (user_id, source, raw_payload, parsed_title, parsed_priority, parsed_tags, task_id, sender_name, sender_username, chat_title, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, 'email', JSON.stringify(req.body), title, priority, tags, taskId, fromName, fromEmail, 'Email', 'success');
    } catch(e) { console.warn('Event log failed:', e); }

    return res.status(200).json({ success: true, task_id: taskId });

  } catch (error) {
    console.error('Email webhook error:', error);
    return res.status(200).json({ success: false, error: 'Internal processing error' });
  }
});

// ── GET /webhooks/events ─────────────────────────────
// Returns webhook events for the authenticated user

router.get('/events', authenticate, (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const source = req.query.source;

    let where = 'WHERE user_id = ?';
    const params = [req.user.id];
    if (source) {
      where += ' AND source = ?';
      params.push(source);
    }

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM webhook_events ${where}`).get(...params).cnt;
    const events = db.prepare(`
      SELECT * FROM webhook_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ events, total });
  } catch (err) {
    console.error('Events fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

module.exports = router;
