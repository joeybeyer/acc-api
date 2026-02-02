/**
 * Portfolio CRUD routes — Sites and GMB listings
 * All scoped by user_id. Admin users can use ?scope=all to see everything.
 */
const { Router } = require('express');
const { getDb } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = Router();

// ── Helper: build WHERE clause for tenant scoping ───

function scopeWhere(req, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  if (req.user.is_admin && req.query.scope === 'all') {
    return { clause: '1=1', params: [] };
  }
  return { clause: `${prefix}user_id = ?`, params: [req.user.id] };
}

// ────────────────────────────────────────────────────
// SITES ROUTES
// ────────────────────────────────────────────────────

// ── GET /portfolio/sites ──────────────────────────────────────

router.get('/sites', (req, res) => {
  try {
    const db = getDb();
    const { status, market, niche, limit = 50, offset = 0 } = req.query;
    const { clause, params } = scopeWhere(req);

    let query = `
      SELECT s.*, 
        COUNT(g.id) as gmb_count 
      FROM sites s 
      LEFT JOIN gmb_listings g ON s.id = g.site_id 
      WHERE ${clause}
    `;

    if (status) {
      query += ' AND s.status = ?';
      params.push(status);
    }
    if (market) {
      query += ' AND s.market = ?';
      params.push(market);
    }
    if (niche) {
      query += ' AND s.niche = ?';
      params.push(niche);
    }

    query += ' GROUP BY s.id ORDER BY s.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const sites = db.prepare(query).all(...params);
    res.json(sites);
  } catch (err) {
    console.error('List sites error:', err);
    res.status(500).json({ error: 'Failed to fetch sites' });
  }
});

// ── GET /portfolio/sites/:id ──────────────────────────────────

router.get('/sites/:id', (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req, 's');
    params.push(req.params.id);

    const site = db.prepare(
      `SELECT * FROM sites s WHERE ${clause} AND s.id = ?`
    ).get(...params);

    if (!site) {
      return res.status(404).json({ error: 'Site not found' });
    }

    // Get linked GMB listings
    const { clause: gmbClause, params: gmbParams } = scopeWhere(req, 'g');
    gmbParams.push(site.id);

    const gmbListings = db.prepare(
      `SELECT * FROM gmb_listings g WHERE ${gmbClause} AND g.site_id = ?`
    ).all(...gmbParams);

    res.json({ ...site, gmb_listings: gmbListings });
  } catch (err) {
    console.error('Get site error:', err);
    res.status(500).json({ error: 'Failed to fetch site' });
  }
});

// ── POST /portfolio/sites ─────────────────────────────────────

router.post('/sites', (req, res) => {
  try {
    const db = getDb();
    const {
      name,
      domain,
      niche,
      market,
      status = 'active',
      hosting,
      template,
      notes
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const result = db.prepare(`
      INSERT INTO sites (user_id, name, domain, niche, market, status, hosting, template, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      name,
      domain || null,
      niche || null,
      market || null,
      status,
      hosting || null,
      template || null,
      notes || null
    );

    // Log activity
    db.prepare(`
      INSERT INTO activity_log (user_id, action, message)
      VALUES (?, 'created', ?)
    `).run(req.user.id, `Site created: ${name}`);

    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(site);
  } catch (err) {
    console.error('Create site error:', err);
    res.status(500).json({ error: 'Failed to create site' });
  }
});

// ── PATCH /portfolio/sites/:id ────────────────────────────────

router.patch('/sites/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    // Verify ownership
    const { clause, params: scopeParams } = scopeWhere(req);
    const existing = db.prepare(
      `SELECT * FROM sites WHERE ${clause} AND id = ?`
    ).get(...scopeParams, id);

    if (!existing) {
      return res.status(404).json({ error: 'Site not found' });
    }

    const { name, domain, niche, market, status, hosting, template, notes } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined)     { updates.push('name = ?');     params.push(name); }
    if (domain !== undefined)   { updates.push('domain = ?');   params.push(domain); }
    if (niche !== undefined)    { updates.push('niche = ?');    params.push(niche); }
    if (market !== undefined)   { updates.push('market = ?');   params.push(market); }
    if (status !== undefined)   { updates.push('status = ?');   params.push(status); }
    if (hosting !== undefined)  { updates.push('hosting = ?');  params.push(hosting); }
    if (template !== undefined) { updates.push('template = ?'); params.push(template); }
    if (notes !== undefined)    { updates.push('notes = ?');    params.push(notes); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE sites SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // Log activity
    db.prepare(`
      INSERT INTO activity_log (user_id, action, message)
      VALUES (?, 'updated', ?)
    `).run(req.user.id, `Site updated: ${existing.name}`);

    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
    res.json(site);
  } catch (err) {
    console.error('Update site error:', err);
    res.status(500).json({ error: 'Failed to update site' });
  }
});

// ── DELETE /portfolio/sites/:id ───────────────────────────────

router.delete('/sites/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const { clause, params } = scopeWhere(req);
    params.push(id);
    const existing = db.prepare(
      `SELECT * FROM sites WHERE ${clause} AND id = ?`
    ).get(...params);

    if (!existing) {
      return res.status(404).json({ error: 'Site not found' });
    }

    // Unlink GMB listings (don't delete them, just remove site_id)
    db.prepare('UPDATE gmb_listings SET site_id = NULL WHERE site_id = ?').run(id);
    
    // Delete the site
    db.prepare('DELETE FROM sites WHERE id = ?').run(id);

    // Log activity
    db.prepare(`
      INSERT INTO activity_log (user_id, action, message)
      VALUES (?, 'deleted', ?)
    `).run(req.user.id, `Site deleted: ${existing.name}`);

    res.json({ success: true, deleted: existing.name });
  } catch (err) {
    console.error('Delete site error:', err);
    res.status(500).json({ error: 'Failed to delete site' });
  }
});

// ────────────────────────────────────────────────────
// GMB LISTINGS ROUTES
// ────────────────────────────────────────────────────

// ── GET /portfolio/gmb ────────────────────────────────────────

router.get('/gmb', (req, res) => {
  try {
    const db = getDb();
    const { status, verification_status, market, limit = 50, offset = 0 } = req.query;
    const { clause, params } = scopeWhere(req, 'g');

    let query = `
      SELECT g.*, s.name as site_name, s.domain as site_domain
      FROM gmb_listings g 
      LEFT JOIN sites s ON g.site_id = s.id
      WHERE ${clause}
    `;

    if (status) {
      query += ' AND g.status = ?';
      params.push(status);
    }
    if (verification_status) {
      query += ' AND g.verification_status = ?';
      params.push(verification_status);
    }
    if (market) {
      query += ' AND g.market = ?';
      params.push(market);
    }

    query += ' ORDER BY g.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const listings = db.prepare(query).all(...params);
    res.json(listings);
  } catch (err) {
    console.error('List GMB listings error:', err);
    res.status(500).json({ error: 'Failed to fetch GMB listings' });
  }
});

// ── GET /portfolio/gmb/:id ────────────────────────────────────

router.get('/gmb/:id', (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req, 'g');
    params.push(req.params.id);

    const listing = db.prepare(
      `SELECT g.*, s.name as site_name, s.domain as site_domain
       FROM gmb_listings g 
       LEFT JOIN sites s ON g.site_id = s.id
       WHERE ${clause} AND g.id = ?`
    ).get(...params);

    if (!listing) {
      return res.status(404).json({ error: 'GMB listing not found' });
    }

    res.json(listing);
  } catch (err) {
    console.error('Get GMB listing error:', err);
    res.status(500).json({ error: 'Failed to fetch GMB listing' });
  }
});

// ── POST /portfolio/gmb ───────────────────────────────────────

router.post('/gmb', (req, res) => {
  try {
    const db = getDb();
    const {
      site_id,
      business_name,
      market,
      category,
      phone,
      address,
      status = 'pending',
      gbp_url,
      verification_status = 'unverified',
      notes
    } = req.body;

    if (!business_name) {
      return res.status(400).json({ error: 'Business name is required' });
    }

    // If site_id provided, verify ownership
    if (site_id) {
      const { clause, params } = scopeWhere(req);
      const site = db.prepare(`SELECT id FROM sites WHERE ${clause} AND id = ?`).get(...params, site_id);
      if (!site) {
        return res.status(400).json({ error: 'Invalid site_id or site not found' });
      }
    }

    const result = db.prepare(`
      INSERT INTO gmb_listings (user_id, site_id, business_name, market, category, phone, address, status, gbp_url, verification_status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      site_id || null,
      business_name,
      market || null,
      category || null,
      phone || null,
      address || null,
      status,
      gbp_url || null,
      verification_status,
      notes || null
    );

    // Log activity
    db.prepare(`
      INSERT INTO activity_log (user_id, action, message)
      VALUES (?, 'created', ?)
    `).run(req.user.id, `GMB listing created: ${business_name}`);

    const listing = db.prepare('SELECT * FROM gmb_listings WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(listing);
  } catch (err) {
    console.error('Create GMB listing error:', err);
    res.status(500).json({ error: 'Failed to create GMB listing' });
  }
});

// ── PATCH /portfolio/gmb/:id ──────────────────────────────────

router.patch('/gmb/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    // Verify ownership
    const { clause, params: scopeParams } = scopeWhere(req);
    const existing = db.prepare(
      `SELECT * FROM gmb_listings WHERE ${clause} AND id = ?`
    ).get(...scopeParams, id);

    if (!existing) {
      return res.status(404).json({ error: 'GMB listing not found' });
    }

    const { site_id, business_name, market, category, phone, address, status, gbp_url, verification_status, notes } = req.body;
    const updates = [];
    const params = [];

    // If site_id being updated, verify ownership
    if (site_id !== undefined && site_id !== null) {
      const { clause: siteClause, params: siteParams } = scopeWhere(req);
      const site = db.prepare(`SELECT id FROM sites WHERE ${siteClause} AND id = ?`).get(...siteParams, site_id);
      if (!site) {
        return res.status(400).json({ error: 'Invalid site_id or site not found' });
      }
    }

    if (site_id !== undefined)          { updates.push('site_id = ?');          params.push(site_id); }
    if (business_name !== undefined)    { updates.push('business_name = ?');    params.push(business_name); }
    if (market !== undefined)           { updates.push('market = ?');           params.push(market); }
    if (category !== undefined)         { updates.push('category = ?');         params.push(category); }
    if (phone !== undefined)            { updates.push('phone = ?');            params.push(phone); }
    if (address !== undefined)          { updates.push('address = ?');          params.push(address); }
    if (status !== undefined)           { updates.push('status = ?');           params.push(status); }
    if (gbp_url !== undefined)          { updates.push('gbp_url = ?');          params.push(gbp_url); }
    if (verification_status !== undefined) { updates.push('verification_status = ?'); params.push(verification_status); }
    if (notes !== undefined)            { updates.push('notes = ?');            params.push(notes); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE gmb_listings SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // Log activity
    db.prepare(`
      INSERT INTO activity_log (user_id, action, message)
      VALUES (?, 'updated', ?)
    `).run(req.user.id, `GMB listing updated: ${existing.business_name}`);

    const listing = db.prepare('SELECT * FROM gmb_listings WHERE id = ?').get(id);
    res.json(listing);
  } catch (err) {
    console.error('Update GMB listing error:', err);
    res.status(500).json({ error: 'Failed to update GMB listing' });
  }
});

// ── DELETE /portfolio/gmb/:id ─────────────────────────────────

router.delete('/gmb/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const { clause, params } = scopeWhere(req);
    params.push(id);
    const existing = db.prepare(
      `SELECT * FROM gmb_listings WHERE ${clause} AND id = ?`
    ).get(...params);

    if (!existing) {
      return res.status(404).json({ error: 'GMB listing not found' });
    }

    db.prepare('DELETE FROM gmb_listings WHERE id = ?').run(id);

    // Log activity
    db.prepare(`
      INSERT INTO activity_log (user_id, action, message)
      VALUES (?, 'deleted', ?)
    `).run(req.user.id, `GMB listing deleted: ${existing.business_name}`);

    res.json({ success: true, deleted: existing.business_name });
  } catch (err) {
    console.error('Delete GMB listing error:', err);
    res.status(500).json({ error: 'Failed to delete GMB listing' });
  }
});

// ────────────────────────────────────────────────────
// STATS ROUTE
// ────────────────────────────────────────────────────

// ── GET /portfolio/stats ──────────────────────────────────────

router.get('/stats', (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);

    const stats = {
      total_sites: db.prepare(`SELECT COUNT(*) as count FROM sites WHERE ${clause}`).get(...params).count,
      active_sites: db.prepare(`SELECT COUNT(*) as count FROM sites WHERE ${clause} AND status = 'active'`).get(...params).count,
      total_gmb: db.prepare(`SELECT COUNT(*) as count FROM gmb_listings WHERE ${clause}`).get(...params).count,
      verified_gmb: db.prepare(`SELECT COUNT(*) as count FROM gmb_listings WHERE ${clause} AND verification_status = 'verified'`).get(...params).count,
      pending_gmb: db.prepare(`SELECT COUNT(*) as count FROM gmb_listings WHERE ${clause} AND status = 'pending'`).get(...params).count,
    };

    // Get unique markets from both tables
    const siteMarkets = db.prepare(`SELECT DISTINCT market FROM sites WHERE ${clause} AND market IS NOT NULL`).all(...params);
    const gmbMarkets = db.prepare(`SELECT DISTINCT market FROM gmb_listings WHERE ${clause} AND market IS NOT NULL`).all(...params);
    const allMarkets = [...new Set([...siteMarkets.map(m => m.market), ...gmbMarkets.map(m => m.market)])];
    stats.markets = allMarkets;

    res.json(stats);
  } catch (err) {
    console.error('Portfolio stats error:', err);
    res.status(500).json({ error: 'Failed to fetch portfolio stats' });
  }
});

module.exports = router;