/**
 * Message Parser — Phase 1 (Rule-Based)
 *
 * Takes a raw message string and extracts structured data:
 *   - intent:    what the sender wants (create_task, update_status, question, alert, info)
 *   - entities:  structured objects found (task refs, people, markets, niches, tools, deadlines)
 *   - urgency:   0-1 score based on language signals
 *   - action:    recommended system action (create, update, notify, search, none)
 *
 * Phase 2 will add LLM-powered intent disambiguation.
 * Phase 3 will add multi-source event normalization (calls, rank alerts, etc.)
 */

// ── Intent Patterns ─────────────────────────────────────

const INTENT_PATTERNS = {
  create_task: {
    priority: 1,
    patterns: [
      /\b(?:add\s+task|todo|task:|new\s+task|create\s+task)\b/i,
      /\b(?:need(?:s)?\s+to|should|gotta|have\s+to|let'?s)\b.*\b(?:build|create|fix|deploy|set\s*up|ship|launch|design|implement|write|add)\b/i,
      /\b(?:build|create|fix|deploy|set\s*up|ship|launch|design|implement)\b.*\b(?:for|in|on|by)\b/i,
    ],
  },
  update_status: {
    priority: 0,
    patterns: [
      /\btask\s*#?\d+\b.*\b(?:is\s+)?(?:done|completed?|finished|shipped|deployed|closed|resolved|fixed)\b/i,
      /\b(?:done\s+with|finished|completed?|shipped|deployed|closed|resolved|fixed)\b.*\btask\s*#?\d+\b/i,
      /\b(?:mark|move|update|change|set)\b.*\b(?:task\s*#?\d+|status)\b/i,
      /\b(?:task\s*#?\d+)\b.*\b(?:needs?\s+to\s+(?:be\s+)?(?:in.progress|review|backlog))\b/i,
      /\b(?:(?:has|have|was|were|got)\s+(?:been\s+)?(?:handled|taken\s+care\s+of|knocked\s+out|wrapped\s+up))\b/i,
    ],
  },
  question: {
    priority: 2,
    patterns: [
      /\b(?:what|where|when|how|why|who)\b.*\?$/im,
      /\b(?:status\s+(?:of|on)|update\s+on|progress\s+on|how(?:'s| is))\b/i,
      /\b(?:can\s+you|could\s+you)\b.*\b(?:check|show|tell|find|look)\b/i,
    ],
  },
  alert: {
    priority: 0,
    patterns: [
      /\b(?:broken|(?:is|went|going)\s+down|error|failed|failing|urgent|emergency)\b/i,
      /\b(?:site\s+down|ssl\s+(?:expired|broken|error)|suspended|flagged|penalized)\b/i,
      /\b(?:not\s+working|can'?t\s+(?:access|connect|load)|500\s+error|404)\b/i,
    ],
  },
  directive: {
    priority: 1,
    patterns: [
      /\b(?:task\s+\d+\s+and\s+\d+|tasks?\s+\d+(?:\s*(?:,|and)\s*\d+)*)\s+(?:need|should|have\s+to|gotta)\b/i,
      /\b(?:handle|take\s+care\s+of|knock\s+out|get\s+(?:on|to)|work\s+on|start)\b/i,
      /\b(?:get\s+(?:this|that|it)\s+(?:done|handled|shipped|built))\b/i,
    ],
  },
  info: {
    priority: 3,
    patterns: [
      // Catch-all: anything that doesn't match above
    ],
  },
};

// ── Entity Extractors ───────────────────────────────────

const ENTITY_EXTRACTORS = {
  /**
   * Task references: "task 101", "task #101", "#101", "tasks 101 and 102"
   */
  task_refs(text) {
    const refs = [];
    // "task 101" / "task #101" / "#101"
    const singlePattern = /\btask\s*#?(\d+)\b|#(\d+)\b/gi;
    let m;
    while ((m = singlePattern.exec(text)) !== null) {
      refs.push(parseInt(m[1] || m[2], 10));
    }
    // "tasks 101 and 102" / "tasks 101, 102, 103"
    const multiPattern = /\btasks?\s+((?:\d+[\s,]*(?:and\s+)?)+)/gi;
    while ((m = multiPattern.exec(text)) !== null) {
      const nums = m[1].match(/\d+/g);
      if (nums) nums.forEach(n => {
        const id = parseInt(n, 10);
        if (!refs.includes(id)) refs.push(id);
      });
    }
    return refs.length > 0 ? refs : null;
  },

  /**
   * People: known names and roles
   */
  people(text) {
    const known = [
      { pattern: /\bevie\b/i, name: 'Evie', role: 'VA' },
      { pattern: /\bbiggelsworth\b/i, name: 'Biggelsworth', role: 'AI' },
      { pattern: /\bjoey\b/i, name: 'Joey', role: 'owner' },
    ];
    const found = [];
    for (const k of known) {
      if (k.pattern.test(text)) found.push({ name: k.name, role: k.role });
    }
    return found.length > 0 ? found : null;
  },

  /**
   * Markets: cities, states, regions
   */
  markets(text) {
    const marketPatterns = [
      { pattern: /\bsan\s+jose\b/i, market: 'San Jose', state: 'CA' },
      { pattern: /\bsan\s+diego\b/i, market: 'San Diego', state: 'CA' },
      { pattern: /\blos\s+angeles\b|\bL\.?A\.?\b/i, market: 'Los Angeles', state: 'CA' },
      { pattern: /\bsan\s+francisco\b|\bS\.?F\.?\b/i, market: 'San Francisco', state: 'CA' },
      { pattern: /\bsan\s+ramon\b/i, market: 'San Ramon', state: 'CA' },
      { pattern: /\bhalf\s+moon\s+bay\b/i, market: 'Half Moon Bay', state: 'CA' },
      { pattern: /\bsanta\s+ana\b/i, market: 'Santa Ana', state: 'CA' },
      { pattern: /\bsunnyvale\b/i, market: 'Sunnyvale', state: 'CA' },
      { pattern: /\bjupiter\b/i, market: 'Jupiter', state: 'FL' },
      { pattern: /\bdallas\b/i, market: 'Dallas', state: 'TX' },
      { pattern: /\bhouston\b/i, market: 'Houston', state: 'TX' },
      { pattern: /\bchicago\b/i, market: 'Chicago', state: 'IL' },
      { pattern: /\batlanta\b/i, market: 'Atlanta', state: 'GA' },
      { pattern: /\bdenver\b/i, market: 'Denver', state: 'CO' },
      { pattern: /\bphoenix\b/i, market: 'Phoenix', state: 'AZ' },
    ];
    const found = [];
    for (const m of marketPatterns) {
      if (m.pattern.test(text)) found.push({ market: m.market, state: m.state });
    }
    return found.length > 0 ? found : null;
  },

  /**
   * Niches: service verticals
   */
  niches(text) {
    const nichePatterns = [
      { pattern: /\bhvac\b/i, niche: 'hvac' },
      { pattern: /\belectric(?:al|ian)?\b/i, niche: 'electrical' },
      { pattern: /\bplumb(?:ing|er)\b/i, niche: 'plumbing' },
      { pattern: /\broof(?:ing|er)\b/i, niche: 'roofing' },
      { pattern: /\bgarage\s+door\b/i, niche: 'garage_door' },
      { pattern: /\bpest\s+control\b/i, niche: 'pest_control' },
      { pattern: /\blandscap(?:ing|er)\b/i, niche: 'landscaping' },
      { pattern: /\btree\s+(?:service|removal|trimming)\b/i, niche: 'tree_service' },
      { pattern: /\block(?:smith)?\b/i, niche: 'locksmith' },
    ];
    const found = [];
    for (const n of nichePatterns) {
      if (n.pattern.test(text)) found.push(n.niche);
    }
    return found.length > 0 ? found : null;
  },

  /**
   * Tools: software and platforms mentioned
   */
  tools(text) {
    const toolPatterns = [
      { pattern: /\bseo\s*neo\b/i, tool: 'SEO Neo' },
      { pattern: /\bgmb\b|\bgoogle\s+(?:business|my\s+business)\b/i, tool: 'GMB' },
      { pattern: /\bacc\b|\bcommand\s+center\b/i, tool: 'ACC' },
      { pattern: /\bn8n\b/i, tool: 'n8n' },
      { pattern: /\bclawdbot\b/i, tool: 'Clawdbot' },
      { pattern: /\bdirect\s*admin\b/i, tool: 'DirectAdmin' },
      { pattern: /\bcloudflare\b/i, tool: 'Cloudflare' },
      { pattern: /\bstripe\b/i, tool: 'Stripe' },
    ];
    const found = [];
    for (const t of toolPatterns) {
      if (t.pattern.test(text)) found.push(t.tool);
    }
    return found.length > 0 ? found : null;
  },

  /**
   * Status targets: what status is being referenced
   */
  target_status(text) {
    const statusMap = [
      { pattern: /\b(?:done|completed?|finished|shipped|deployed|resolved|fixed|wrapped\s+up|handled|knocked\s+out)\b/i, status: 'completed' },
      { pattern: /\b(?:in.progress|started?|working\s+on|on\s+it)\b/i, status: 'in_progress' },
      { pattern: /\b(?:review|ready\s+for\s+review|needs?\s+review)\b/i, status: 'review' },
      { pattern: /\b(?:backlog|shelved?|later|on\s+hold|paused?)\b/i, status: 'backlog' },
    ];
    for (const s of statusMap) {
      if (s.pattern.test(text)) return s.status;
    }
    return null;
  },

  /**
   * Deadlines: time expressions
   */
  deadlines(text) {
    const patterns = [
      { pattern: /\bby\s+(?:end\s+of\s+)?(?:today|eod|tonight)\b/i, deadline: 'today' },
      { pattern: /\bby\s+(?:end\s+of\s+)?tomorrow\b/i, deadline: 'tomorrow' },
      { pattern: /\bby\s+(?:end\s+of\s+)?(?:this\s+)?week\b|eow\b/i, deadline: 'this_week' },
      { pattern: /\basap\b|\bright\s+now\b|\bimmediately\b/i, deadline: 'asap' },
      { pattern: /\bby\s+(\w+day)\b/i, deadline: null, extract: true },
    ];
    for (const p of patterns) {
      const m = text.match(p.pattern);
      if (m) {
        return p.extract ? m[1].toLowerCase() : p.deadline;
      }
    }
    return null;
  },
};

// ── Urgency Scoring ─────────────────────────────────────

const URGENCY_SIGNALS = [
  { pattern: /\b(?:asap|urgent|emergency|critical|now|immediately)\b/i, weight: 0.4 },
  { pattern: /\b(?:broken|down|failed|error|not\s+working)\b/i, weight: 0.3 },
  { pattern: /\b(?:today|tonight|eod|right\s+away)\b/i, weight: 0.2 },
  { pattern: /\b(?:important|priority|needs?\s+attention)\b/i, weight: 0.15 },
  { pattern: /!{2,}/, weight: 0.1 },  // Multiple exclamation marks
  { pattern: /[A-Z]{4,}/, weight: 0.05 },  // ALL CAPS words
];

function computeUrgency(text) {
  let score = 0;
  for (const signal of URGENCY_SIGNALS) {
    if (signal.pattern.test(text)) {
      score += signal.weight;
    }
  }
  return Math.min(score, 1.0);
}

// ── Action Mapping ──────────────────────────────────────

function determineAction(intent, entities) {
  switch (intent) {
    case 'create_task':
      return 'create';
    case 'update_status':
      return entities.task_refs ? 'update' : 'search_and_update';
    case 'question':
      return entities.task_refs ? 'lookup' : 'search';
    case 'alert':
      return 'create';  // Alerts auto-create tasks
    case 'directive':
      return entities.task_refs ? 'update' : 'create';
    default:
      return 'none';
  }
}

// ── Main Parse Function ─────────────────────────────────

/**
 * Parse a raw message into a structured event.
 *
 * @param {string} text     — Raw message text
 * @param {Object} meta     — Optional metadata { source, sender, timestamp, channel }
 * @returns {Object} parsed event
 */
function parse(text, meta = {}) {
  if (!text || typeof text !== 'string') {
    return {
      intent: 'info',
      confidence: 0,
      entities: {},
      urgency: 0,
      action: 'none',
      raw: text || '',
      meta,
    };
  }

  const trimmed = text.trim();

  // ── Detect intent ──
  let intent = 'info';
  let confidence = 0.3;  // Default low confidence for catch-all
  let matchedPattern = null;

  for (const [intentName, config] of Object.entries(INTENT_PATTERNS)) {
    if (intentName === 'info') continue;  // Skip catch-all

    for (const pattern of config.patterns) {
      if (pattern.test(trimmed)) {
        // Higher priority intents (lower number) win ties
        if (!matchedPattern || config.priority < matchedPattern.priority ||
            (config.priority === matchedPattern.priority && intentName === 'update_status')) {
          intent = intentName;
          confidence = 0.7 + (0.1 * (3 - config.priority));  // 0.7-1.0 based on priority
          matchedPattern = config;
        }
        break;
      }
    }
  }

  // ── Extract entities ──
  const entities = {};
  for (const [name, extractor] of Object.entries(ENTITY_EXTRACTORS)) {
    const result = extractor(trimmed);
    if (result !== null) {
      entities[name] = result;
    }
  }

  // ── Boost confidence if entities corroborate intent ──
  if (intent === 'update_status' && entities.task_refs) confidence = Math.min(confidence + 0.15, 1.0);
  if (intent === 'create_task' && entities.niches) confidence = Math.min(confidence + 0.1, 1.0);
  if (intent === 'alert' && entities.tools) confidence = Math.min(confidence + 0.1, 1.0);

  // ── Compute urgency ──
  const urgency = computeUrgency(trimmed);

  // ── Determine action ──
  const action = determineAction(intent, entities);

  // ── Extract title (for create_task intent) ──
  let suggestedTitle = null;
  if (intent === 'create_task' || intent === 'alert') {
    suggestedTitle = extractTitle(trimmed);
  }

  return {
    intent,
    confidence,
    entities,
    urgency,
    action,
    suggestedTitle,
    raw: trimmed,
    meta: {
      source: meta.source || 'unknown',
      sender: meta.sender || null,
      timestamp: meta.timestamp || new Date().toISOString(),
      channel: meta.channel || null,
    },
  };
}

/**
 * Extract a clean title from a task-creation message.
 */
function extractTitle(text) {
  // Strip prefixes like "add task:", "todo:", "task:"
  let title = text
    .replace(/^(?:add\s+task|todo|task|new\s+task|create\s+task)\s*:\s*/i, '')
    .replace(/^(?:need(?:s)?\s+to|should|gotta|have\s+to|let'?s)\s+/i, '')
    .trim();

  // Cap at 120 chars
  if (title.length > 120) {
    title = title.substring(0, 117) + '...';
  }

  // Capitalize first letter
  if (title.length > 0) {
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }

  return title;
}

module.exports = {
  parse,
  computeUrgency,
  extractTitle,
  INTENT_PATTERNS,
  ENTITY_EXTRACTORS,
  URGENCY_SIGNALS,
};
