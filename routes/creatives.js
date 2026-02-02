/**
 * Creative Loop Engine — API Routes
 *
 * All routes require authentication and the 'creative_loop' module.
 * Every query is scoped to req.user.id (tenant isolation).
 *
 * Mount at: app.use('/creatives', auth, requireCreativeLoop, creativesRouter)
 * Also exports sub-routers for prompts, metrics, naming, loop, and stats.
 */
const { Router } = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { diagnose, diagnoseBatch, DEFAULT_CONFIG } = require('../services/diagnosis');
const { mutate } = require('../services/mutator');

const router = Router();

// ── Module gate middleware ───────────────────────────
// Checks user has 'creative_loop' access. Admins bypass.

function requireCreativeLoop(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Admins always have access
  if (req.user.is_admin) return next();

  const db = getDb();
  // Check user_modules table if it exists
  try {
    const hasModule = db.prepare(
      `SELECT 1 FROM user_modules
       WHERE user_id = ? AND module_slug = 'creative_loop' AND status = 'active'`
    ).get(req.user.id);

    if (hasModule) return next();
  } catch (e) {
    // Table may not exist yet — fall through to plan check
  }

  // Fallback: check plan level (agency gets everything)
  if (req.user.plan === 'agency') return next();

  return res.status(403).json({
    error: 'module_required',
    module: 'creative_loop',
    message: 'This feature requires the Creative Loop Engine module ($149/mo). Upgrade in Settings → Modules.',
  });
}

// ── Helpers ─────────────────────────────────────────

function scopeWhere(req, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  if (req.user.is_admin && req.query.scope === 'all') {
    return { clause: '1=1', params: [] };
  }
  return { clause: `${prefix}user_id = ?`, params: [req.user.id] };
}

function parseJSON(str, fallback = {}) {
  if (!str) return fallback;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

function serializeRow(row) {
  if (!row) return null;
  return {
    ...row,
    metrics: parseJSON(row.metrics, {}),
    variables: row.variables ? parseJSON(row.variables, {}) : undefined,
  };
}

function getUserConfig(userId) {
  const db = getDb();
  const config = db.prepare('SELECT * FROM loop_configs WHERE user_id = ?').get(userId);
  if (config) return config;
  return { ...DEFAULT_CONFIG };
}

// ═══════════════════════════════════════════════════════
//  CREATIVE CRUD
// ═══════════════════════════════════════════════════════

// ── GET /creatives ──────────────────────────────────

router.get('/', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { status, campaign, creative_type, platform, search, sort, order, limit = 50, offset = 0 } = req.query;
    const { clause, params } = scopeWhere(req);

    let query = `SELECT * FROM ad_creatives WHERE ${clause}`;

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    if (campaign) {
      query += ' AND campaign_name = ?';
      params.push(campaign);
    }
    if (creative_type) {
      query += ' AND creative_type = ?';
      params.push(creative_type);
    }
    if (platform) {
      query += ' AND platform = ?';
      params.push(platform);
    }
    if (search) {
      query += ' AND (variant_name LIKE ? OR campaign_name LIKE ? OR naming_code LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    // Sorting
    const validSorts = ['created_at', 'updated_at', 'generation', 'status', 'campaign_name'];
    const sortCol = validSorts.includes(sort) ? sort : 'created_at';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const rows = db.prepare(query).all(...params);

    // Get total count for pagination
    const countQuery = query.replace(/SELECT \*/, 'SELECT COUNT(*) as total').replace(/ORDER BY.*$/, '');
    const countParams = params.slice(0, -2); // remove limit/offset
    const { total } = db.prepare(
      `SELECT COUNT(*) as total FROM ad_creatives WHERE ${clause}${status ? ' AND status = ?' : ''}${campaign ? ' AND campaign_name = ?' : ''}${creative_type ? ' AND creative_type = ?' : ''}${platform ? ' AND platform = ?' : ''}${search ? ' AND (variant_name LIKE ? OR campaign_name LIKE ? OR naming_code LIKE ?)' : ''}`
    ).get(...countParams);

    res.json({
      data: rows.map(serializeRow),
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    console.error('List creatives error:', err);
    res.status(500).json({ error: 'Failed to fetch creatives' });
  }
});

// ── GET /creatives/:id ──────────────────────────────

router.get('/:id', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);
    params.push(req.params.id);

    const row = db.prepare(
      `SELECT c.*, p.name as prompt_name, p.prompt_text, p.variables as prompt_variables
       FROM ad_creatives c
       LEFT JOIN prompt_library p ON c.prompt_id = p.id
       WHERE ${clause.replace(/user_id/, 'c.user_id')} AND c.id = ?`
    ).get(...params);

    if (!row) return res.status(404).json({ error: 'Creative not found' });

    const result = serializeRow(row);
    result.prompt_variables = parseJSON(row.prompt_variables, {});
    res.json(result);
  } catch (err) {
    console.error('Get creative error:', err);
    res.status(500).json({ error: 'Failed to fetch creative' });
  }
});

// ── POST /creatives ─────────────────────────────────

router.post('/', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const {
      variant_name,
      campaign_name,
      ad_set_name,
      naming_code,
      prompt_id,
      platform = 'facebook',
      platform_ad_id,
      platform_campaign_id,
      platform_adset_id,
      status = 'draft',
      creative_type = 'image',
      creative_url,
      parent_id,
      variable_changed,
      variable_value,
      metrics,
    } = req.body;

    if (!variant_name) {
      return res.status(400).json({ error: 'variant_name is required' });
    }

    const external_id = crypto.randomUUID();

    // Calculate generation from parent
    let generation = 1;
    if (parent_id) {
      const parent = db.prepare('SELECT generation FROM ad_creatives WHERE id = ? AND user_id = ?')
        .get(parent_id, req.user.id);
      if (parent) generation = parent.generation + 1;
    }

    const result = db.prepare(`
      INSERT INTO ad_creatives (
        user_id, external_id, variant_name, campaign_name, ad_set_name, naming_code,
        prompt_id, platform, platform_ad_id, platform_campaign_id, platform_adset_id,
        status, creative_type, creative_url, parent_id, generation,
        variable_changed, variable_value, metrics
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id, external_id, variant_name, campaign_name || null, ad_set_name || null,
      naming_code || null, prompt_id || null, platform, platform_ad_id || null,
      platform_campaign_id || null, platform_adset_id || null, status, creative_type,
      creative_url || null, parent_id || null, generation,
      variable_changed || null, variable_value || null,
      metrics ? JSON.stringify(metrics) : '{}',
    );

    // If using a prompt, increment its times_used
    if (prompt_id) {
      db.prepare('UPDATE prompt_library SET times_used = times_used + 1 WHERE id = ? AND user_id = ?')
        .run(prompt_id, req.user.id);
    }

    const row = db.prepare('SELECT * FROM ad_creatives WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(serializeRow(row));
  } catch (err) {
    console.error('Create creative error:', err);
    res.status(500).json({ error: 'Failed to create creative' });
  }
});

// ── PATCH /creatives/:id ────────────────────────────

router.patch('/:id', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { clause, params: scopeParams } = scopeWhere(req);

    const existing = db.prepare(
      `SELECT * FROM ad_creatives WHERE ${clause} AND id = ?`
    ).get(...scopeParams, id);

    if (!existing) return res.status(404).json({ error: 'Creative not found' });

    const allowedFields = [
      'variant_name', 'campaign_name', 'ad_set_name', 'naming_code', 'prompt_id',
      'platform_ad_id', 'platform_campaign_id', 'platform_adset_id', 'status',
      'creative_type', 'creative_url', 'variable_changed', 'variable_value',
      'diagnosis', 'diagnosis_action',
    ];

    const updates = [];
    const params = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    }

    // Handle metrics (merge or replace)
    if (req.body.metrics) {
      updates.push('metrics = ?');
      params.push(JSON.stringify(req.body.metrics));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE ad_creatives SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const row = db.prepare('SELECT * FROM ad_creatives WHERE id = ?').get(id);
    res.json(serializeRow(row));
  } catch (err) {
    console.error('Update creative error:', err);
    res.status(500).json({ error: 'Failed to update creative' });
  }
});

// ── DELETE /creatives/:id (soft archive) ────────────

router.delete('/:id', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { clause, params } = scopeWhere(req);
    params.push(id);

    const existing = db.prepare(
      `SELECT * FROM ad_creatives WHERE ${clause} AND id = ?`
    ).get(...params);

    if (!existing) return res.status(404).json({ error: 'Creative not found' });

    // Soft delete — archive it
    db.prepare(
      `UPDATE ad_creatives SET status = 'archived', updated_at = datetime('now') WHERE id = ?`
    ).run(id);

    res.json({ success: true, archived: existing.variant_name });
  } catch (err) {
    console.error('Archive creative error:', err);
    res.status(500).json({ error: 'Failed to archive creative' });
  }
});

// ═══════════════════════════════════════════════════════
//  LINEAGE & ANALYSIS
// ═══════════════════════════════════════════════════════

// ── GET /creatives/:id/lineage ──────────────────────

router.get('/:id/lineage', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);
    params.push(req.params.id);

    const creative = db.prepare(
      `SELECT * FROM ad_creatives WHERE ${clause} AND id = ?`
    ).get(...params);

    if (!creative) return res.status(404).json({ error: 'Creative not found' });

    // Walk up to find the root ancestor
    let root = creative;
    const ancestors = [];
    while (root.parent_id) {
      const parent = db.prepare(
        'SELECT * FROM ad_creatives WHERE id = ? AND user_id = ?'
      ).get(root.parent_id, req.user.id);
      if (!parent) break;
      ancestors.unshift(serializeRow(parent));
      root = parent;
    }

    // Walk down to find all descendants (BFS)
    const descendants = [];
    const queue = [creative.id];
    while (queue.length > 0) {
      const parentId = queue.shift();
      const children = db.prepare(
        'SELECT * FROM ad_creatives WHERE parent_id = ? AND user_id = ?'
      ).all(parentId, req.user.id);
      for (const child of children) {
        descendants.push(serializeRow(child));
        queue.push(child.id);
      }
    }

    res.json({
      current: serializeRow(creative),
      ancestors,
      descendants,
      total_generations: ancestors.length + 1 + (descendants.length > 0 ? Math.max(...descendants.map(d => d.generation)) - creative.generation : 0),
    });
  } catch (err) {
    console.error('Lineage error:', err);
    res.status(500).json({ error: 'Failed to fetch lineage' });
  }
});

// ── GET /creatives/:id/metrics ──────────────────────

router.get('/:id/metrics', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);
    params.push(req.params.id);

    const creative = db.prepare(
      `SELECT id FROM ad_creatives WHERE ${clause} AND id = ?`
    ).get(...params);

    if (!creative) return res.status(404).json({ error: 'Creative not found' });

    const snapshots = db.prepare(
      'SELECT * FROM metric_snapshots WHERE creative_id = ? ORDER BY snapshot_date DESC'
    ).all(req.params.id);

    res.json({
      creative_id: parseInt(req.params.id),
      snapshots,
      count: snapshots.length,
    });
  } catch (err) {
    console.error('Metric history error:', err);
    res.status(500).json({ error: 'Failed to fetch metric history' });
  }
});

// ── POST /creatives/:id/analyze ─────────────────────

router.post('/:id/analyze', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);
    params.push(req.params.id);

    const creative = db.prepare(
      `SELECT * FROM ad_creatives WHERE ${clause} AND id = ?`
    ).get(...params);

    if (!creative) return res.status(404).json({ error: 'Creative not found' });

    const metrics = parseJSON(creative.metrics, {});
    const config = getUserConfig(req.user.id);

    // Get previous snapshot for trend analysis
    const snapshots = db.prepare(
      'SELECT * FROM metric_snapshots WHERE creative_id = ? ORDER BY snapshot_date DESC LIMIT 10'
    ).all(creative.id);

    const previous = snapshots.length > 1 ? snapshots[1] : null;

    const result = diagnose(metrics, previous, config, snapshots);

    // Store diagnosis on the creative
    db.prepare(
      `UPDATE ad_creatives SET diagnosis = ?, diagnosis_action = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(result.suggestion, result.action, creative.id);

    res.json({
      creative_id: creative.id,
      diagnosis: result,
      metrics,
      previous_snapshot: previous,
    });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: 'Failed to analyze creative' });
  }
});

// ── POST /creatives/:id/variant ─────────────────────

router.post('/:id/variant', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);
    params.push(req.params.id);

    const creative = db.prepare(
      `SELECT c.*, p.prompt_text, p.variables as prompt_variables
       FROM ad_creatives c
       LEFT JOIN prompt_library p ON c.prompt_id = p.id
       WHERE ${clause.replace(/user_id/, 'c.user_id')} AND c.id = ?`
    ).get(...params);

    if (!creative) return res.status(404).json({ error: 'Creative not found' });

    // Get or compute diagnosis
    let diagnosisResult;
    if (req.body.force_action) {
      // Allow manual override of diagnosis action
      diagnosisResult = {
        action: req.body.force_action,
        problem: 'Manual override',
        suggestion: `Manually triggered ${req.body.force_action}`,
      };
    } else {
      const metrics = parseJSON(creative.metrics, {});
      const config = getUserConfig(req.user.id);
      const snapshots = db.prepare(
        'SELECT * FROM metric_snapshots WHERE creative_id = ? ORDER BY snapshot_date DESC LIMIT 10'
      ).all(creative.id);
      const previous = snapshots.length > 1 ? snapshots[1] : null;
      diagnosisResult = diagnose(metrics, previous, config, snapshots);
    }

    // Don't mutate winners or things to pause
    if (['scale', 'pause', 'monitor', 'wait'].includes(diagnosisResult.action)) {
      return res.json({
        creative_id: creative.id,
        diagnosis: diagnosisResult,
        variant_created: false,
        reason: `Action "${diagnosisResult.action}" does not require a new variant.`,
      });
    }

    // Build prompt object for mutator
    const promptObj = {
      prompt_text: creative.prompt_text || '',
      variables: parseJSON(creative.prompt_variables, {}),
    };

    const mutation = mutate(promptObj, diagnosisResult);

    if (!mutation.variableChanged) {
      return res.json({
        creative_id: creative.id,
        diagnosis: diagnosisResult,
        mutation,
        variant_created: false,
        reason: mutation.reason,
      });
    }

    // Create new prompt version if text changed
    let newPromptId = creative.prompt_id;
    if (mutation.newPromptText !== promptObj.prompt_text || JSON.stringify(mutation.newVariables) !== JSON.stringify(promptObj.variables)) {
      const promptResult = db.prepare(`
        INSERT INTO prompt_library (user_id, name, prompt_text, variables, category)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        req.user.id,
        `Variant of prompt #${creative.prompt_id || 'unknown'}`,
        mutation.newPromptText,
        JSON.stringify(mutation.newVariables),
        null, // inherit category later
      );
      newPromptId = promptResult.lastInsertRowid;
    }

    // Create the variant creative
    const external_id = crypto.randomUUID();
    const generation = creative.generation + 1;
    const variantName = `${creative.variant_name}_v${generation}`;

    const variantResult = db.prepare(`
      INSERT INTO ad_creatives (
        user_id, external_id, variant_name, campaign_name, ad_set_name,
        prompt_id, platform, status, creative_type,
        parent_id, generation, variable_changed, variable_value, metrics
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, '{}')
    `).run(
      req.user.id, external_id, variantName, creative.campaign_name,
      creative.ad_set_name, newPromptId, creative.platform,
      creative.creative_type, creative.id, generation,
      mutation.variableChanged, mutation.newValue,
    );

    const variant = db.prepare('SELECT * FROM ad_creatives WHERE id = ?').get(variantResult.lastInsertRowid);

    res.status(201).json({
      creative_id: creative.id,
      diagnosis: diagnosisResult,
      mutation,
      variant_created: true,
      variant: serializeRow(variant),
    });
  } catch (err) {
    console.error('Variant creation error:', err);
    res.status(500).json({ error: 'Failed to create variant' });
  }
});


// ═══════════════════════════════════════════════════════
//  PROMPT LIBRARY
// ═══════════════════════════════════════════════════════

const promptRouter = Router();

// ── GET /prompts ────────────────────────────────────

promptRouter.get('/', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { category, sort, order, limit = 50, offset = 0 } = req.query;
    const { clause, params } = scopeWhere(req);

    let query = `SELECT * FROM prompt_library WHERE ${clause}`;
    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }

    const validSorts = ['performance_score', 'times_used', 'created_at', 'best_ctr', 'best_cpa'];
    const sortCol = validSorts.includes(sort) ? sort : 'performance_score';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const rows = db.prepare(query).all(...params);
    res.json(rows.map(r => ({ ...r, variables: parseJSON(r.variables, {}) })));
  } catch (err) {
    console.error('List prompts error:', err);
    res.status(500).json({ error: 'Failed to fetch prompts' });
  }
});

// ── GET /prompts/:id ────────────────────────────────

promptRouter.get('/:id', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);
    params.push(req.params.id);

    const row = db.prepare(
      `SELECT * FROM prompt_library WHERE ${clause} AND id = ?`
    ).get(...params);

    if (!row) return res.status(404).json({ error: 'Prompt not found' });
    res.json({ ...row, variables: parseJSON(row.variables, {}) });
  } catch (err) {
    console.error('Get prompt error:', err);
    res.status(500).json({ error: 'Failed to fetch prompt' });
  }
});

// ── POST /prompts ───────────────────────────────────

promptRouter.post('/', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { name, prompt_text, variables, category } = req.body;

    if (!prompt_text) {
      return res.status(400).json({ error: 'prompt_text is required' });
    }

    const result = db.prepare(`
      INSERT INTO prompt_library (user_id, name, prompt_text, variables, category)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      name || null,
      prompt_text,
      variables ? JSON.stringify(variables) : '{}',
      category || null,
    );

    const row = db.prepare('SELECT * FROM prompt_library WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ ...row, variables: parseJSON(row.variables, {}) });
  } catch (err) {
    console.error('Create prompt error:', err);
    res.status(500).json({ error: 'Failed to create prompt' });
  }
});

// ── PATCH /prompts/:id ──────────────────────────────

promptRouter.patch('/:id', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { clause, params: scopeParams } = scopeWhere(req);

    const existing = db.prepare(
      `SELECT * FROM prompt_library WHERE ${clause} AND id = ?`
    ).get(...scopeParams, id);

    if (!existing) return res.status(404).json({ error: 'Prompt not found' });

    const updates = [];
    const params = [];
    const fields = ['name', 'prompt_text', 'category'];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    }
    if (req.body.variables !== undefined) {
      updates.push('variables = ?');
      params.push(JSON.stringify(req.body.variables));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);
    db.prepare(`UPDATE prompt_library SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const row = db.prepare('SELECT * FROM prompt_library WHERE id = ?').get(id);
    res.json({ ...row, variables: parseJSON(row.variables, {}) });
  } catch (err) {
    console.error('Update prompt error:', err);
    res.status(500).json({ error: 'Failed to update prompt' });
  }
});

// ── GET /prompts/:id/performance ────────────────────

promptRouter.get('/:id/performance', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);
    params.push(req.params.id);

    const prompt = db.prepare(
      `SELECT * FROM prompt_library WHERE ${clause} AND id = ?`
    ).get(...params);

    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });

    // Aggregate metrics from all creatives using this prompt
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_creatives,
        SUM(CASE WHEN status = 'winner' THEN 1 ELSE 0 END) as winners,
        SUM(CASE WHEN status = 'loser' THEN 1 ELSE 0 END) as losers,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
      FROM ad_creatives
      WHERE user_id = ? AND prompt_id = ?
    `).get(req.user.id, req.params.id);

    // Get metric averages from snapshots of creatives using this prompt
    const metricAvgs = db.prepare(`
      SELECT
        AVG(ms.ctr) as avg_ctr,
        AVG(ms.cpa) as avg_cpa,
        AVG(ms.cpc) as avg_cpc,
        MIN(ms.cpa) as best_cpa,
        MAX(ms.ctr) as best_ctr,
        SUM(ms.spend) as total_spend,
        SUM(ms.conversions) as total_conversions
      FROM metric_snapshots ms
      INNER JOIN ad_creatives c ON ms.creative_id = c.id
      WHERE c.user_id = ? AND c.prompt_id = ?
    `).get(req.user.id, req.params.id);

    res.json({
      prompt_id: parseInt(req.params.id),
      ...stats,
      metrics: metricAvgs,
    });
  } catch (err) {
    console.error('Prompt performance error:', err);
    res.status(500).json({ error: 'Failed to fetch prompt performance' });
  }
});

// ── GET /prompts/:id/creatives ──────────────────────

promptRouter.get('/:id/creatives', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM ad_creatives WHERE user_id = ? AND prompt_id = ? ORDER BY created_at DESC'
    ).all(req.user.id, req.params.id);

    res.json(rows.map(serializeRow));
  } catch (err) {
    console.error('Prompt creatives error:', err);
    res.status(500).json({ error: 'Failed to fetch prompt creatives' });
  }
});


// ═══════════════════════════════════════════════════════
//  METRICS INGESTION
// ═══════════════════════════════════════════════════════

const metricsRouter = Router();

// ── POST /metrics/ingest ────────────────────────────
// Bulk ingest from Facebook API pull

metricsRouter.post('/ingest', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { ads } = req.body;

    if (!Array.isArray(ads) || ads.length === 0) {
      return res.status(400).json({ error: 'ads array is required' });
    }

    const results = { updated: 0, created: 0, skipped: 0, errors: [] };

    const upsertCreative = db.prepare(`
      UPDATE ad_creatives SET
        metrics = ?,
        updated_at = datetime('now')
      WHERE platform_ad_id = ? AND user_id = ?
    `);

    const insertSnapshot = db.prepare(`
      INSERT INTO metric_snapshots (
        creative_id, snapshot_date, impressions, clicks, spend, conversions,
        ctr, cpc, cpa, cpm, frequency, relevance_score
      ) VALUES (?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const findByPlatformId = db.prepare(
      'SELECT id FROM ad_creatives WHERE platform_ad_id = ? AND user_id = ?'
    );

    const ingestTx = db.transaction(() => {
      for (const ad of ads) {
        try {
          if (!ad.platform_ad_id) {
            results.skipped++;
            continue;
          }

          const metrics = {
            impressions: ad.impressions || 0,
            clicks: ad.clicks || 0,
            spend: ad.spend || 0,
            conversions: ad.conversions || 0,
            ctr: ad.ctr || (ad.impressions > 0 ? (ad.clicks / ad.impressions * 100) : 0),
            cpc: ad.cpc || (ad.clicks > 0 ? ad.spend / ad.clicks : 0),
            cpa: ad.cpa || (ad.conversions > 0 ? ad.spend / ad.conversions : null),
            cpm: ad.cpm || (ad.impressions > 0 ? (ad.spend / ad.impressions * 1000) : 0),
            frequency: ad.frequency || null,
            relevance_score: ad.relevance_score || null,
          };

          // Update creative's current metrics
          const updateResult = upsertCreative.run(
            JSON.stringify(metrics), ad.platform_ad_id, req.user.id
          );

          if (updateResult.changes > 0) {
            results.updated++;

            // Insert snapshot
            const creative = findByPlatformId.get(ad.platform_ad_id, req.user.id);
            if (creative) {
              insertSnapshot.run(
                creative.id, metrics.impressions, metrics.clicks, metrics.spend,
                metrics.conversions, metrics.ctr, metrics.cpc, metrics.cpa,
                metrics.cpm, metrics.frequency, metrics.relevance_score,
              );
            }
          } else {
            results.skipped++;
          }
        } catch (adErr) {
          results.errors.push({ platform_ad_id: ad.platform_ad_id, error: adErr.message });
        }
      }
    });

    ingestTx();
    res.json(results);
  } catch (err) {
    console.error('Metrics ingest error:', err);
    res.status(500).json({ error: 'Failed to ingest metrics' });
  }
});

// ── POST /metrics/snapshot ──────────────────────────
// Point-in-time snapshot of all active creatives

metricsRouter.post('/snapshot', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();

    const actives = db.prepare(
      `SELECT id, metrics FROM ad_creatives WHERE user_id = ? AND status IN ('active', 'testing')`
    ).all(req.user.id);

    const insertSnapshot = db.prepare(`
      INSERT INTO metric_snapshots (
        creative_id, snapshot_date, impressions, clicks, spend, conversions,
        ctr, cpc, cpa, cpm, frequency, relevance_score
      ) VALUES (?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let snapshotted = 0;
    const snapTx = db.transaction(() => {
      for (const creative of actives) {
        const m = parseJSON(creative.metrics, {});
        if (m.impressions != null) {
          insertSnapshot.run(
            creative.id, m.impressions || 0, m.clicks || 0, m.spend || 0,
            m.conversions || 0, m.ctr || null, m.cpc || null, m.cpa || null,
            m.cpm || null, m.frequency || null, m.relevance_score || null,
          );
          snapshotted++;
        }
      }
    });

    snapTx();
    res.json({ snapshotted, total_active: actives.length });
  } catch (err) {
    console.error('Snapshot error:', err);
    res.status(500).json({ error: 'Failed to create snapshots' });
  }
});


// ═══════════════════════════════════════════════════════
//  NAMING CONVENTIONS
// ═══════════════════════════════════════════════════════

const namingRouter = Router();

// ── GET /naming-conventions ─────────────────────────

namingRouter.get('/', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM naming_conventions WHERE user_id = ? ORDER BY is_default DESC, created_at DESC'
    ).all(req.user.id);
    res.json(rows);
  } catch (err) {
    console.error('List naming conventions error:', err);
    res.status(500).json({ error: 'Failed to fetch naming conventions' });
  }
});

// ── POST /naming-conventions ────────────────────────

namingRouter.post('/', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { name, template, is_default } = req.body;

    if (!template) {
      return res.status(400).json({ error: 'template is required' });
    }

    // If setting as default, unset others first
    if (is_default) {
      db.prepare('UPDATE naming_conventions SET is_default = 0 WHERE user_id = ?').run(req.user.id);
    }

    const result = db.prepare(
      'INSERT INTO naming_conventions (user_id, name, template, is_default) VALUES (?, ?, ?, ?)'
    ).run(req.user.id, name || null, template, is_default ? 1 : 0);

    const row = db.prepare('SELECT * FROM naming_conventions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(row);
  } catch (err) {
    console.error('Create naming convention error:', err);
    res.status(500).json({ error: 'Failed to create naming convention' });
  }
});

// ── POST /naming-conventions/generate ───────────────

namingRouter.post('/generate', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { template_id, variables } = req.body;

    let template;
    if (template_id) {
      const row = db.prepare(
        'SELECT template FROM naming_conventions WHERE id = ? AND user_id = ?'
      ).get(template_id, req.user.id);
      if (!row) return res.status(404).json({ error: 'Naming template not found' });
      template = row.template;
    } else {
      // Use default template
      const row = db.prepare(
        'SELECT template FROM naming_conventions WHERE user_id = ? AND is_default = 1'
      ).get(req.user.id);
      template = row ? row.template : '{campaign}_{variant}_{promptID}_{variable}_{version}';
    }

    // Replace {placeholders} with variable values
    let name = template;
    const vars = variables || {};
    for (const [key, value] of Object.entries(vars)) {
      name = name.replace(new RegExp(`\\{${key}\\}`, 'gi'), String(value));
    }
    // Clean up any unreplaced placeholders
    name = name.replace(/\{[^}]+\}/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

    res.json({ name, template, variables: vars });
  } catch (err) {
    console.error('Generate name error:', err);
    res.status(500).json({ error: 'Failed to generate name' });
  }
});


// ═══════════════════════════════════════════════════════
//  LOOP CONTROL
// ═══════════════════════════════════════════════════════

const loopRouter = Router();

// ── POST /loop/run ──────────────────────────────────
// Full loop iteration: analyze all active → diagnose → create variants

loopRouter.post('/run', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const config = getUserConfig(req.user.id);
    const maxVariants = config.max_variants_per_run || 5;

    // Create a loop run record
    const runResult = db.prepare(
      'INSERT INTO loop_runs (user_id) VALUES (?)'
    ).run(req.user.id);
    const runId = runResult.lastInsertRowid;

    // Get all active/testing creatives
    const actives = db.prepare(
      `SELECT c.*, p.prompt_text, p.variables as prompt_variables
       FROM ad_creatives c
       LEFT JOIN prompt_library p ON c.prompt_id = p.id
       WHERE c.user_id = ? AND c.status IN ('active', 'testing')
       ORDER BY c.updated_at ASC`
    ).all(req.user.id);

    const results = {
      analyzed: 0,
      variants_created: 0,
      winners: 0,
      paused: 0,
      errors: [],
      details: [],
    };

    for (const creative of actives) {
      try {
        const metrics = parseJSON(creative.metrics, {});
        const snapshots = db.prepare(
          'SELECT * FROM metric_snapshots WHERE creative_id = ? ORDER BY snapshot_date DESC LIMIT 10'
        ).all(creative.id);
        const previous = snapshots.length > 1 ? snapshots[1] : null;

        const diagResult = diagnose(metrics, previous, config, snapshots);
        results.analyzed++;

        // Store diagnosis
        db.prepare(
          `UPDATE ad_creatives SET diagnosis = ?, diagnosis_action = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(diagResult.suggestion, diagResult.action, creative.id);

        const detail = {
          creative_id: creative.id,
          variant_name: creative.variant_name,
          action: diagResult.action,
          severity: diagResult.severity,
          problem: diagResult.problem,
        };

        // Act on diagnosis
        if (diagResult.action === 'scale') {
          results.winners++;
          db.prepare("UPDATE ad_creatives SET status = 'winner', updated_at = datetime('now') WHERE id = ?")
            .run(creative.id);
          detail.result = 'marked_winner';
        } else if (diagResult.action === 'pause') {
          results.paused++;
          if (config.auto_pause_losers) {
            db.prepare("UPDATE ad_creatives SET status = 'loser', updated_at = datetime('now') WHERE id = ?")
              .run(creative.id);
            detail.result = 'auto_paused';
          } else {
            detail.result = 'pause_recommended';
          }
        } else if (['swap_hook', 'add_trust', 'change_recipe', 'improve_relevance'].includes(diagResult.action)) {
          if (results.variants_created < maxVariants) {
            // Create variant
            const promptObj = {
              prompt_text: creative.prompt_text || '',
              variables: parseJSON(creative.prompt_variables, {}),
            };
            const mutation = mutate(promptObj, diagResult);

            if (mutation.variableChanged) {
              // Save new prompt if changed
              let newPromptId = creative.prompt_id;
              if (mutation.newPromptText !== promptObj.prompt_text) {
                const pResult = db.prepare(
                  'INSERT INTO prompt_library (user_id, name, prompt_text, variables, category) VALUES (?, ?, ?, ?, ?)'
                ).run(req.user.id, `Loop variant of #${creative.prompt_id}`, mutation.newPromptText, JSON.stringify(mutation.newVariables), null);
                newPromptId = pResult.lastInsertRowid;
              }

              const extId = crypto.randomUUID();
              db.prepare(`
                INSERT INTO ad_creatives (
                  user_id, external_id, variant_name, campaign_name, ad_set_name,
                  prompt_id, platform, status, creative_type,
                  parent_id, generation, variable_changed, variable_value, metrics
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, '{}')
              `).run(
                req.user.id, extId, `${creative.variant_name}_v${creative.generation + 1}`,
                creative.campaign_name, creative.ad_set_name, newPromptId,
                creative.platform, creative.creative_type, creative.id,
                creative.generation + 1, mutation.variableChanged, mutation.newValue,
              );

              results.variants_created++;
              detail.result = 'variant_created';
              detail.mutation = {
                variable: mutation.variableChanged,
                from: mutation.oldValue,
                to: mutation.newValue,
                strategy: mutation.strategy,
              };
            } else {
              detail.result = 'no_mutation_match';
              detail.reason = mutation.reason;
            }
          } else {
            detail.result = 'max_variants_reached';
          }
        } else {
          detail.result = 'monitoring';
        }

        results.details.push(detail);
      } catch (creativeErr) {
        results.errors.push({ creative_id: creative.id, error: creativeErr.message });
      }
    }

    // Update loop run record
    db.prepare(`
      UPDATE loop_runs SET
        completed_at = datetime('now'),
        status = 'completed',
        creatives_analyzed = ?,
        variants_created = ?,
        winners_found = ?,
        losers_paused = ?,
        errors = ?,
        summary = ?
      WHERE id = ?
    `).run(
      results.analyzed, results.variants_created, results.winners, results.paused,
      JSON.stringify(results.errors),
      `Analyzed ${results.analyzed} creatives. Created ${results.variants_created} variants. ${results.winners} winners, ${results.paused} paused.`,
      runId,
    );

    res.json({ run_id: runId, ...results });
  } catch (err) {
    console.error('Loop run error:', err);
    res.status(500).json({ error: 'Failed to run loop' });
  }
});

// ── GET /loop/history ───────────────────────────────

loopRouter.get('/history', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const { limit = 20, offset = 0 } = req.query;
    const rows = db.prepare(
      'SELECT * FROM loop_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'
    ).all(req.user.id, parseInt(limit), parseInt(offset));

    res.json(rows.map(r => ({ ...r, errors: parseJSON(r.errors, []) })));
  } catch (err) {
    console.error('Loop history error:', err);
    res.status(500).json({ error: 'Failed to fetch loop history' });
  }
});

// ── GET /loop/config ────────────────────────────────

loopRouter.get('/config', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const config = db.prepare('SELECT * FROM loop_configs WHERE user_id = ?').get(req.user.id);

    if (config) {
      res.json(config);
    } else {
      // Return defaults
      res.json({
        user_id: req.user.id,
        ...DEFAULT_CONFIG,
        auto_post: 0,
        auto_pause_losers: 1,
        auto_scale_winners: 0,
        schedule_cron: null,
        max_variants_per_run: 5,
      });
    }
  } catch (err) {
    console.error('Get loop config error:', err);
    res.status(500).json({ error: 'Failed to fetch loop config' });
  }
});

// ── PATCH /loop/config ──────────────────────────────

loopRouter.patch('/config', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM loop_configs WHERE user_id = ?').get(req.user.id);

    const fields = [
      'ctr_low_threshold', 'ctr_winner_threshold', 'cpa_target', 'cpc_multiplier',
      'frequency_fatigue', 'ctr_decline_pct', 'auto_post', 'auto_pause_losers',
      'auto_scale_winners', 'schedule_cron', 'max_variants_per_run',
    ];

    if (existing) {
      const updates = [];
      const params = [];
      for (const field of fields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          params.push(req.body[field]);
        }
      }
      if (updates.length === 0) return res.status(400).json({ error: 'No updates provided' });

      updates.push("updated_at = datetime('now')");
      params.push(req.user.id);
      db.prepare(`UPDATE loop_configs SET ${updates.join(', ')} WHERE user_id = ?`).run(...params);
    } else {
      // Create config with defaults + overrides
      const config = { ...DEFAULT_CONFIG };
      for (const field of fields) {
        if (req.body[field] !== undefined) config[field] = req.body[field];
      }
      db.prepare(`
        INSERT INTO loop_configs (
          user_id, ctr_low_threshold, ctr_winner_threshold, cpa_target, cpc_multiplier,
          frequency_fatigue, ctr_decline_pct, auto_post, auto_pause_losers,
          auto_scale_winners, schedule_cron, max_variants_per_run
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.user.id, config.ctr_low_threshold, config.ctr_winner_threshold,
        config.cpa_target, config.cpc_multiplier, config.frequency_fatigue,
        config.ctr_decline_pct, config.auto_post ?? 0, config.auto_pause_losers ?? 1,
        config.auto_scale_winners ?? 0, config.schedule_cron ?? null,
        config.max_variants_per_run ?? 5,
      );
    }

    const row = db.prepare('SELECT * FROM loop_configs WHERE user_id = ?').get(req.user.id);
    res.json(row);
  } catch (err) {
    console.error('Update loop config error:', err);
    res.status(500).json({ error: 'Failed to update loop config' });
  }
});


// ═══════════════════════════════════════════════════════
//  DASHBOARD STATS
// ═══════════════════════════════════════════════════════

const statsRouter = Router();

// ── GET /creative-stats ─────────────────────────────

statsRouter.get('/', requireCreativeLoop, (req, res) => {
  try {
    const db = getDb();

    // Overall counts
    const counts = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as drafts,
        SUM(CASE WHEN status = 'testing' THEN 1 ELSE 0 END) as testing,
        SUM(CASE WHEN status = 'winner' THEN 1 ELSE 0 END) as winners,
        SUM(CASE WHEN status = 'loser' THEN 1 ELSE 0 END) as losers,
        SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived,
        AVG(generation) as avg_generation,
        MAX(generation) as max_generation
      FROM ad_creatives WHERE user_id = ?
    `).get(req.user.id);

    // CTR improvement: avg CTR of latest gen vs gen 1
    const ctrImprovement = db.prepare(`
      SELECT
        (SELECT AVG(CAST(json_extract(metrics, '$.ctr') AS REAL))
         FROM ad_creatives WHERE user_id = ? AND generation > 1 AND status != 'archived') as evolved_ctr,
        (SELECT AVG(CAST(json_extract(metrics, '$.ctr') AS REAL))
         FROM ad_creatives WHERE user_id = ? AND generation = 1 AND status != 'archived') as original_ctr
    `).get(req.user.id, req.user.id);

    // Best performing prompt
    const bestPrompt = db.prepare(`
      SELECT id, name, performance_score, times_used, best_ctr
      FROM prompt_library
      WHERE user_id = ?
      ORDER BY performance_score DESC
      LIMIT 1
    `).get(req.user.id);

    // Total spend and conversions
    const spending = db.prepare(`
      SELECT
        SUM(spend) as total_spend,
        SUM(conversions) as total_conversions,
        AVG(cpa) as avg_cpa
      FROM metric_snapshots ms
      INNER JOIN ad_creatives c ON ms.creative_id = c.id
      WHERE c.user_id = ?
    `).get(req.user.id);

    // Recent loop runs
    const recentRuns = db.prepare(
      'SELECT * FROM loop_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 5'
    ).all(req.user.id);

    // Top campaigns
    const topCampaigns = db.prepare(`
      SELECT campaign_name, COUNT(*) as creative_count,
        SUM(CASE WHEN status = 'winner' THEN 1 ELSE 0 END) as winners
      FROM ad_creatives
      WHERE user_id = ? AND campaign_name IS NOT NULL
      GROUP BY campaign_name
      ORDER BY creative_count DESC
      LIMIT 5
    `).all(req.user.id);

    const improvement = (ctrImprovement.evolved_ctr && ctrImprovement.original_ctr)
      ? ((ctrImprovement.evolved_ctr - ctrImprovement.original_ctr) / ctrImprovement.original_ctr * 100)
      : null;

    res.json({
      creatives: counts,
      ctr_improvement: {
        original_avg_ctr: ctrImprovement.original_ctr,
        evolved_avg_ctr: ctrImprovement.evolved_ctr,
        improvement_pct: improvement,
      },
      best_prompt: bestPrompt || null,
      spending: spending || { total_spend: 0, total_conversions: 0, avg_cpa: null },
      recent_loop_runs: recentRuns.map(r => ({ ...r, errors: parseJSON(r.errors, []) })),
      top_campaigns: topCampaigns,
    });
  } catch (err) {
    console.error('Creative stats error:', err);
    res.status(500).json({ error: 'Failed to fetch creative stats' });
  }
});


// ═══════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════

module.exports = {
  creativesRouter: router,
  promptRouter,
  metricsRouter,
  namingRouter,
  loopRouter,
  statsRouter,
  requireCreativeLoop,
};
