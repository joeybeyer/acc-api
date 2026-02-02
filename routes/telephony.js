/**
 * Telephony Integration Routes
 * Supports both SignalWire and Twilio for call tracking
 */

const express = require('express');
const { getDb } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ────────────────────────────────────────────────────────────────
// Config Management
// ────────────────────────────────────────────────────────────────

// GET /telephony/config - Get user's telephony config (mask tokens)
router.get('/config', authenticate, (req, res) => {
  try {
    const db = getDb();
    const config = db.prepare(`
      SELECT 
        signalwire_project_id,
        signalwire_api_token,
        signalwire_space_url,
        twilio_account_sid,
        twilio_auth_token,
        default_provider
      FROM telephony_configs 
      WHERE user_id = ?
    `).get(req.user.id);

    if (!config) {
      return res.json({
        signalwire_project_id: null,
        signalwire_api_token: null,
        signalwire_space_url: null,
        twilio_account_sid: null,
        twilio_auth_token: null,
        default_provider: 'signalwire'
      });
    }

    // Mask sensitive tokens (show only last 4 chars)
    const maskToken = (token) => {
      if (!token || token.length <= 4) return token;
      return '●●●●' + token.slice(-4);
    };

    res.json({
      signalwire_project_id: config.signalwire_project_id,
      signalwire_api_token: maskToken(config.signalwire_api_token),
      signalwire_space_url: config.signalwire_space_url,
      twilio_account_sid: config.twilio_account_sid,
      twilio_auth_token: maskToken(config.twilio_auth_token),
      default_provider: config.default_provider
    });
  } catch (error) {
    console.error('Error fetching telephony config:', error);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// PUT /telephony/config - Save/update telephony config
router.put('/config', authenticate, (req, res) => {
  try {
    const {
      signalwire_project_id,
      signalwire_api_token,
      signalwire_space_url,
      twilio_account_sid,
      twilio_auth_token,
      default_provider = 'signalwire'
    } = req.body;

    const db = getDb();
    
    // Check if config exists
    const existingConfig = db.prepare(`
      SELECT id FROM telephony_configs WHERE user_id = ?
    `).get(req.user.id);

    if (existingConfig) {
      // Update existing config
      db.prepare(`
        UPDATE telephony_configs SET
          signalwire_project_id = ?,
          signalwire_api_token = ?,
          signalwire_space_url = ?,
          twilio_account_sid = ?,
          twilio_auth_token = ?,
          default_provider = ?,
          updated_at = datetime('now')
        WHERE user_id = ?
      `).run(
        signalwire_project_id,
        signalwire_api_token,
        signalwire_space_url,
        twilio_account_sid,
        twilio_auth_token,
        default_provider,
        req.user.id
      );
    } else {
      // Create new config
      db.prepare(`
        INSERT INTO telephony_configs (
          user_id, signalwire_project_id, signalwire_api_token, 
          signalwire_space_url, twilio_account_sid, twilio_auth_token, 
          default_provider
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.user.id,
        signalwire_project_id,
        signalwire_api_token,
        signalwire_space_url,
        twilio_account_sid,
        twilio_auth_token,
        default_provider
      );
    }

    res.json({ success: true, message: 'Config saved successfully' });
  } catch (error) {
    console.error('Error saving telephony config:', error);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// ────────────────────────────────────────────────────────────────
// Phone Numbers Management
// ────────────────────────────────────────────────────────────────

// GET /telephony/numbers - List all phone numbers for user
router.get('/numbers', authenticate, (req, res) => {
  try {
    const db = getDb();
    const numbers = db.prepare(`
      SELECT * FROM phone_numbers 
      WHERE user_id = ? 
      ORDER BY created_at DESC
    `).all(req.user.id);

    res.json(numbers);
  } catch (error) {
    console.error('Error fetching phone numbers:', error);
    res.status(500).json({ error: 'Failed to fetch phone numbers' });
  }
});

// POST /telephony/numbers - Add a phone number
router.post('/numbers', authenticate, (req, res) => {
  try {
    const { number, provider = 'signalwire', label, market, forward_to } = req.body;

    if (!number) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO phone_numbers (
        user_id, number, provider, label, market, forward_to
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.user.id, number, provider, label, market, forward_to);

    const newNumber = db.prepare(`
      SELECT * FROM phone_numbers WHERE id = ?
    `).get(result.lastInsertRowid);

    res.json(newNumber);
  } catch (error) {
    console.error('Error adding phone number:', error);
    res.status(500).json({ error: 'Failed to add phone number' });
  }
});

// PATCH /telephony/numbers/:id - Update phone number
router.patch('/numbers/:id', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const { number, provider, label, market, forward_to, status } = req.body;

    const db = getDb();
    
    // Verify ownership
    const phoneNumber = db.prepare(`
      SELECT * FROM phone_numbers WHERE id = ? AND user_id = ?
    `).get(id, req.user.id);

    if (!phoneNumber) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    // Build dynamic update query
    const updates = [];
    const values = [];
    
    if (number !== undefined) { updates.push('number = ?'); values.push(number); }
    if (provider !== undefined) { updates.push('provider = ?'); values.push(provider); }
    if (label !== undefined) { updates.push('label = ?'); values.push(label); }
    if (market !== undefined) { updates.push('market = ?'); values.push(market); }
    if (forward_to !== undefined) { updates.push('forward_to = ?'); values.push(forward_to); }
    if (status !== undefined) { updates.push('status = ?'); values.push(status); }
    
    updates.push('updated_at = datetime(\'now\')');
    values.push(id, req.user.id);

    if (updates.length === 1) { // Only updated_at
      return res.json(phoneNumber);
    }

    db.prepare(`
      UPDATE phone_numbers SET ${updates.join(', ')} 
      WHERE id = ? AND user_id = ?
    `).run(...values);

    const updatedNumber = db.prepare(`
      SELECT * FROM phone_numbers WHERE id = ?
    `).get(id);

    res.json(updatedNumber);
  } catch (error) {
    console.error('Error updating phone number:', error);
    res.status(500).json({ error: 'Failed to update phone number' });
  }
});

// DELETE /telephony/numbers/:id - Delete phone number
router.delete('/numbers/:id', authenticate, (req, res) => {
  try {
    const { id } = req.params;

    const db = getDb();
    
    // Verify ownership
    const phoneNumber = db.prepare(`
      SELECT * FROM phone_numbers WHERE id = ? AND user_id = ?
    `).get(id, req.user.id);

    if (!phoneNumber) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    db.prepare(`DELETE FROM phone_numbers WHERE id = ? AND user_id = ?`)
      .run(id, req.user.id);

    res.json({ success: true, message: 'Phone number deleted' });
  } catch (error) {
    console.error('Error deleting phone number:', error);
    res.status(500).json({ error: 'Failed to delete phone number' });
  }
});

// ────────────────────────────────────────────────────────────────
// Call Logs
// ────────────────────────────────────────────────────────────────

// GET /telephony/calls - List call logs with pagination
router.get('/calls', authenticate, (req, res) => {
  try {
    const {
      limit = 50,
      offset = 0,
      market = '',
      provider = ''
    } = req.query;

    const db = getDb();
    
    let whereClause = 'WHERE cl.user_id = ?';
    const params = [req.user.id];

    if (market) {
      whereClause += ' AND cl.market = ?';
      params.push(market);
    }

    if (provider) {
      whereClause += ' AND cl.provider = ?';
      params.push(provider);
    }

    const calls = db.prepare(`
      SELECT 
        cl.*,
        pn.number as phone_number,
        pn.label as phone_label
      FROM call_logs cl
      LEFT JOIN phone_numbers pn ON cl.phone_number_id = pn.id
      ${whereClause}
      ORDER BY cl.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    // Get total count
    const totalCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM call_logs cl
      ${whereClause}
    `).get(...params).count;

    res.json({
      calls,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: totalCount,
        hasMore: (parseInt(offset) + parseInt(limit)) < totalCount
      }
    });
  } catch (error) {
    console.error('Error fetching call logs:', error);
    res.status(500).json({ error: 'Failed to fetch call logs' });
  }
});

// GET /telephony/calls/stats - Call statistics
router.get('/calls/stats', authenticate, (req, res) => {
  try {
    const db = getDb();
    const userId = req.user.id;

    // Total calls
    const totalCalls = db.prepare(`
      SELECT COUNT(*) as count FROM call_logs WHERE user_id = ?
    `).get(userId).count;

    // Calls today
    const todayCalls = db.prepare(`
      SELECT COUNT(*) as count 
      FROM call_logs 
      WHERE user_id = ? AND date(created_at) = date('now')
    `).get(userId).count;

    // Average duration
    const avgDuration = db.prepare(`
      SELECT AVG(duration_seconds) as avg_duration 
      FROM call_logs 
      WHERE user_id = ? AND duration_seconds > 0
    `).get(userId).avg_duration || 0;

    // Calls by market
    const callsByMarket = db.prepare(`
      SELECT market, COUNT(*) as count 
      FROM call_logs 
      WHERE user_id = ? AND market IS NOT NULL
      GROUP BY market 
      ORDER BY count DESC
    `).all(userId);

    // Calls by provider
    const callsByProvider = db.prepare(`
      SELECT provider, COUNT(*) as count 
      FROM call_logs 
      WHERE user_id = ?
      GROUP BY provider 
      ORDER BY count DESC
    `).all(userId);

    // Active phone numbers count
    const activeNumbers = db.prepare(`
      SELECT COUNT(*) as count 
      FROM phone_numbers 
      WHERE user_id = ? AND status = 'active'
    `).get(userId).count;

    res.json({
      total_calls: totalCalls,
      today_calls: todayCalls,
      avg_duration: Math.round(avgDuration),
      active_numbers: activeNumbers,
      calls_by_market: callsByMarket,
      calls_by_provider: callsByProvider
    });
  } catch (error) {
    console.error('Error fetching call stats:', error);
    res.status(500).json({ error: 'Failed to fetch call stats' });
  }
});

// ────────────────────────────────────────────────────────────────
// Webhooks (no auth - called by SignalWire/Twilio)
// ────────────────────────────────────────────────────────────────

// POST /telephony/webhook/signalwire
router.post('/webhook/signalwire', (req, res) => {
  try {
    const {
      CallSid,
      From,
      To,
      CallStatus,
      Duration,
      RecordingUrl,
      CallerName
    } = req.body;

    const db = getDb();

    // Look up phone number and user
    const phoneNumber = db.prepare(`
      SELECT id, user_id, market FROM phone_numbers WHERE number = ?
    `).get(To);

    if (!phoneNumber) {
      console.log(`SignalWire webhook: Phone number ${To} not found`);
      return res.status(200).send('OK'); // Still return 200 to avoid retries
    }

    const duration = parseInt(Duration) || 0;

    // Insert/update call log
    const existingCall = db.prepare(`
      SELECT id FROM call_logs WHERE call_sid = ?
    `).get(CallSid);

    if (existingCall) {
      // Update existing call
      db.prepare(`
        UPDATE call_logs SET
          status = ?,
          duration_seconds = ?,
          recording_url = ?
        WHERE call_sid = ?
      `).run(CallStatus, duration, RecordingUrl, CallSid);
    } else {
      // Create new call log
      db.prepare(`
        INSERT INTO call_logs (
          user_id, phone_number_id, provider, call_sid, direction,
          from_number, to_number, caller_name, duration_seconds,
          status, recording_url, market
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        phoneNumber.user_id,
        phoneNumber.id,
        'signalwire',
        CallSid,
        'inbound',
        From,
        To,
        CallerName,
        duration,
        CallStatus,
        RecordingUrl,
        phoneNumber.market
      );

      // Create activity log entry
      db.prepare(`
        INSERT INTO activity_logs (user_id, action, details)
        VALUES (?, ?, ?)
      `).run(
        phoneNumber.user_id,
        'call_received',
        `Call received: ${From} → ${To} (${duration}s)`
      );
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('SignalWire webhook error:', error);
    res.status(500).send('Error processing webhook');
  }
});

// POST /telephony/webhook/twilio
router.post('/webhook/twilio', (req, res) => {
  try {
    const {
      CallSid,
      From,
      To,
      CallStatus,
      CallDuration, // Twilio uses CallDuration instead of Duration
      RecordingUrl,
      CallerName
    } = req.body;

    const db = getDb();

    // Look up phone number and user
    const phoneNumber = db.prepare(`
      SELECT id, user_id, market FROM phone_numbers WHERE number = ?
    `).get(To);

    if (!phoneNumber) {
      console.log(`Twilio webhook: Phone number ${To} not found`);
      return res.status(200).send('OK'); // Still return 200 to avoid retries
    }

    const duration = parseInt(CallDuration) || 0;

    // Insert/update call log
    const existingCall = db.prepare(`
      SELECT id FROM call_logs WHERE call_sid = ?
    `).get(CallSid);

    if (existingCall) {
      // Update existing call
      db.prepare(`
        UPDATE call_logs SET
          status = ?,
          duration_seconds = ?,
          recording_url = ?
        WHERE call_sid = ?
      `).run(CallStatus, duration, RecordingUrl, CallSid);
    } else {
      // Create new call log
      db.prepare(`
        INSERT INTO call_logs (
          user_id, phone_number_id, provider, call_sid, direction,
          from_number, to_number, caller_name, duration_seconds,
          status, recording_url, market
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        phoneNumber.user_id,
        phoneNumber.id,
        'twilio',
        CallSid,
        'inbound',
        From,
        To,
        CallerName,
        duration,
        CallStatus,
        RecordingUrl,
        phoneNumber.market
      );

      // Create activity log entry
      db.prepare(`
        INSERT INTO activity_logs (user_id, action, details)
        VALUES (?, ?, ?)
      `).run(
        phoneNumber.user_id,
        'call_received',
        `Call received: ${From} → ${To} (${duration}s)`
      );
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Twilio webhook error:', error);
    res.status(500).send('Error processing webhook');
  }
});

module.exports = router;