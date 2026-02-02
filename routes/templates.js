/**
 * Template management routes — list, preview, deploy, and manage deployed sites.
 * All routes scoped by user_id.
 */
const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');

const router = Router();

// ── Load registry ───────────────────────────────────

const REGISTRY_PATH = path.resolve(__dirname, '../../templates/registry.json');

function loadRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load template registry:', err.message);
    return { templates: [], categories: [] };
  }
}

// ── Ensure deployed_sites table exists ──────────────

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployed_sites (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      template_id   TEXT NOT NULL,
      brand_name    TEXT,
      city          TEXT,
      state         TEXT,
      placeholders  TEXT DEFAULT '{}',
      domain        TEXT,
      status        TEXT DEFAULT 'generated',
      created_at    DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_deployed_user ON deployed_sites(user_id);
    CREATE INDEX IF NOT EXISTS idx_deployed_template ON deployed_sites(template_id);
  `);
}

// Run on module load
ensureTable();

// ── Helpers ─────────────────────────────────────────

function scopeWhere(req, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  if (req.user.is_admin && req.query.scope === 'all') {
    return { clause: '1=1', params: [] };
  }
  return { clause: `${prefix}user_id = ?`, params: [req.user.id] };
}

/** Replace all [PLACEHOLDER] tokens in text with provided values. */
function replacePlaceholders(text, values) {
  let result = text;
  for (const [key, val] of Object.entries(values)) {
    const token = `[${key.toUpperCase()}]`;
    result = result.split(token).join(val || '');
  }
  return result;
}

/** Read all template source files recursively. Returns array of {relativePath, content}. */
function readTemplateFiles(sourceDir) {
  const files = [];
  const absDir = path.resolve(__dirname, '../../../', sourceDir);

  if (!fs.existsSync(absDir)) return files;

  function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Skip node_modules, .git, etc.
        if (['node_modules', '.git', '.DS_Store'].includes(entry.name)) continue;
        walk(fullPath, relPath);
      } else {
        // Only process text-based files
        const ext = path.extname(entry.name).toLowerCase();
        const textExts = ['.html', '.css', '.js', '.json', '.txt', '.md', '.svg', '.xml'];
        if (textExts.includes(ext)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            files.push({ relativePath: relPath, content });
          } catch (e) {
            // Skip unreadable files
          }
        }
      }
    }
  }

  walk(absDir, '');
  return files;
}

// ── GET /templates ──────────────────────────────────
// List all templates from registry

router.get('/', (req, res) => {
  try {
    const registry = loadRegistry();
    const { category, search, status } = req.query;

    let templates = registry.templates;

    // Filter by category
    if (category && category !== 'all') {
      templates = templates.filter(t => t.category === category);
    }

    // Filter by status
    if (status) {
      templates = templates.filter(t => t.status === status);
    }

    // Search by name/description
    if (search) {
      const q = search.toLowerCase();
      templates = templates.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
      );
    }

    res.json({
      templates,
      categories: registry.categories,
      total: templates.length,
    });
  } catch (err) {
    console.error('List templates error:', err);
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

// ── GET /templates/deployed ─────────────────────────
// List user's deployed sites (MUST be before /:id)

router.get('/deployed', (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);

    const sites = db.prepare(`
      SELECT * FROM deployed_sites
      WHERE ${clause}
      ORDER BY created_at DESC
      LIMIT 100
    `).all(...params);

    const parsed = sites.map(s => ({
      ...s,
      placeholders: JSON.parse(s.placeholders || '{}'),
    }));

    res.json({ deployed_sites: parsed, total: parsed.length });
  } catch (err) {
    console.error('List deployed sites error:', err);
    res.status(500).json({ error: 'Failed to list deployed sites' });
  }
});

// ── GET /templates/deployed/:id ─────────────────────

router.get('/deployed/:id', (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);

    const site = db.prepare(`
      SELECT * FROM deployed_sites
      WHERE id = ? AND ${clause}
    `).get(req.params.id, ...params);

    if (!site) {
      return res.status(404).json({ error: 'Deployed site not found' });
    }

    site.placeholders = JSON.parse(site.placeholders || '{}');
    res.json(site);
  } catch (err) {
    console.error('Get deployed site error:', err);
    res.status(500).json({ error: 'Failed to get deployed site' });
  }
});

// ── DELETE /templates/deployed/:id ──────────────────

router.delete('/deployed/:id', (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = scopeWhere(req);

    const result = db.prepare(`
      DELETE FROM deployed_sites
      WHERE id = ? AND ${clause}
    `).run(req.params.id, ...params);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Deployed site not found' });
    }

    res.json({ success: true, message: 'Deployed site removed' });
  } catch (err) {
    console.error('Delete deployed site error:', err);
    res.status(500).json({ error: 'Failed to delete deployed site' });
  }
});

// ── GET /templates/:id ──────────────────────────────
// Get single template details + placeholder info

router.get('/:id', (req, res) => {
  try {
    const registry = loadRegistry();
    const template = registry.templates.find(t => t.id === req.params.id);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Enrich with placeholder labels
    const placeholderLabels = {
      BRAND: { label: 'Business Name', type: 'text', placeholder: 'e.g. Dumpster Champs', required: true },
      CITY: { label: 'City', type: 'text', placeholder: 'e.g. Newport Beach', required: true },
      STATE: { label: 'State', type: 'text', placeholder: 'e.g. CA', required: true },
      PHONE: { label: 'Phone Number (display)', type: 'tel', placeholder: 'e.g. (949) 555-1234', required: true },
      PHONE_LINK: { label: 'Phone Number (digits only)', type: 'tel', placeholder: 'e.g. +19495551234', required: true, autoFillFrom: 'PHONE' },
      PRICE: { label: 'Starting Price', type: 'text', placeholder: 'e.g. $495', required: false },
    };

    const enrichedPlaceholders = template.placeholders.map(key => ({
      key,
      ...placeholderLabels[key] || { label: key, type: 'text', placeholder: '', required: false },
    }));

    // Find the category
    const category = registry.categories.find(c => c.id === template.category);

    res.json({
      ...template,
      placeholderDetails: enrichedPlaceholders,
      categoryInfo: category || null,
    });
  } catch (err) {
    console.error('Get template error:', err);
    res.status(500).json({ error: 'Failed to get template' });
  }
});

// ── POST /templates/:id/preview ─────────────────────
// Generate a preview with sample or provided placeholder values

router.post('/:id/preview', (req, res) => {
  try {
    const registry = loadRegistry();
    const template = registry.templates.find(t => t.id === req.params.id);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Use provided values or defaults
    const defaults = {
      BRAND: 'Acme Services',
      CITY: 'Springfield',
      STATE: 'IL',
      PHONE: '(555) 123-4567',
      PHONE_LINK: '+15551234567',
      PRICE: '$299',
    };

    const values = { ...defaults, ...req.body.placeholders };

    // Read and process the index.html
    const sourceFiles = readTemplateFiles(template.source);
    const indexFile = sourceFiles.find(f => f.relativePath === 'index.html');

    if (!indexFile) {
      return res.status(404).json({ error: 'Template index.html not found' });
    }

    const previewHtml = replacePlaceholders(indexFile.content, values);

    res.json({
      template_id: template.id,
      placeholders_used: values,
      preview_html: previewHtml,
      file_count: sourceFiles.length,
    });
  } catch (err) {
    console.error('Preview template error:', err);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

// ── POST /templates/:id/deploy ──────────────────────
// Generate a complete site from template + user's placeholder values

router.post('/:id/deploy', (req, res) => {
  try {
    const registry = loadRegistry();
    const template = registry.templates.find(t => t.id === req.params.id);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (template.status !== 'ready') {
      return res.status(400).json({ error: 'Template is not ready for deployment' });
    }

    const { placeholders, domain } = req.body;

    if (!placeholders || !placeholders.BRAND || !placeholders.CITY) {
      return res.status(400).json({ error: 'BRAND and CITY are required placeholders' });
    }

    // Read all template source files
    const sourceFiles = readTemplateFiles(template.source);

    if (sourceFiles.length === 0) {
      return res.status(404).json({ error: 'Template source files not found' });
    }

    // Process all files with placeholder replacement
    const generatedFiles = sourceFiles.map(file => ({
      relativePath: file.relativePath,
      content: replacePlaceholders(file.content, placeholders),
    }));

    // Create deployed_sites record
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO deployed_sites (user_id, template_id, brand_name, city, state, placeholders, domain, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'generated')
    `).run(
      req.user.id,
      template.id,
      placeholders.BRAND || '',
      placeholders.CITY || '',
      placeholders.STATE || '',
      JSON.stringify(placeholders),
      domain || null
    );

    const deployedSite = db.prepare('SELECT * FROM deployed_sites WHERE id = ?').get(result.lastInsertRowid);
    deployedSite.placeholders = JSON.parse(deployedSite.placeholders || '{}');

    res.json({
      success: true,
      deployed_site: deployedSite,
      generated_files: generatedFiles.map(f => ({
        relativePath: f.relativePath,
        content: f.content,
        size: Buffer.byteLength(f.content, 'utf8'),
      })),
      file_count: generatedFiles.length,
    });
  } catch (err) {
    console.error('Deploy template error:', err);
    res.status(500).json({ error: 'Failed to deploy template' });
  }
});

module.exports = router;
