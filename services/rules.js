/**
 * Rules Engine — Takes parsed events and applies business logic.
 *
 * Pipeline: raw message → parser.parse() → rules.apply() → actionable event
 *
 * Rules handle:
 *   - Priority escalation (urgency signals → task priority)
 *   - Tag inference (markets, niches, tools → auto-tags)
 *   - Task template selection (known patterns → pre-built task shapes)
 *   - Completion detection (for lifecycle automation)
 *   - Source routing (which system should handle this)
 */

const { parse } = require('./parser');

// ── Priority Rules ──────────────────────────────────────

const PRIORITY_RULES = [
  { condition: (e) => e.urgency >= 0.6, priority: 'critical' },
  { condition: (e) => e.urgency >= 0.3, priority: 'high' },
  { condition: (e) => e.intent === 'alert', priority: 'critical' },
  { condition: (e) => e.entities.deadlines === 'asap', priority: 'critical' },
  { condition: (e) => e.entities.deadlines === 'today', priority: 'high' },
  { condition: (e) => e.entities.deadlines === 'tomorrow', priority: 'medium' },
];

function inferPriority(parsed) {
  for (const rule of PRIORITY_RULES) {
    if (rule.condition(parsed)) return rule.priority;
  }
  return 'medium';
}

// ── Tag Inference ───────────────────────────────────────

function inferTags(parsed) {
  const tags = [];

  // Market tags
  if (parsed.entities.markets) {
    for (const m of parsed.entities.markets) {
      tags.push(`market:${m.market.toLowerCase().replace(/\s+/g, '-')}`);
      tags.push(`state:${m.state.toLowerCase()}`);
    }
  }

  // Niche tags
  if (parsed.entities.niches) {
    for (const n of parsed.entities.niches) {
      tags.push(`niche:${n}`);
    }
  }

  // Tool tags
  if (parsed.entities.tools) {
    for (const t of parsed.entities.tools) {
      tags.push(`tool:${t.toLowerCase().replace(/\s+/g, '-')}`);
    }
  }

  // Intent-based tags
  if (parsed.intent === 'alert') tags.push('type:alert');
  if (parsed.intent === 'directive') tags.push('type:directive');

  // Urgency tag
  if (parsed.urgency >= 0.5) tags.push('urgent');

  // Deduplicate
  return [...new Set(tags)];
}

// ── Task Templates ──────────────────────────────────────
// Known patterns that map to pre-built task shapes

const TASK_TEMPLATES = [
  {
    name: 'gmb_deployment',
    match: (parsed) =>
      parsed.entities.niches &&
      parsed.entities.markets &&
      /\b(?:deploy|launch|create|build|set\s*up|plant)\b/i.test(parsed.raw),
    template: (parsed) => ({
      title: `Deploy ${parsed.entities.niches[0].toUpperCase()} GMBs in ${parsed.entities.markets.map(m => m.market).join(', ')}`,
      description: `Deploy Google Business profiles for ${parsed.entities.niches.join(', ')} in ${parsed.entities.markets.map(m => `${m.market}, ${m.state}`).join('; ')}`,
      tags: inferTags(parsed),
      source: parsed.meta.source,
    }),
  },
  {
    name: 'site_issue',
    match: (parsed) =>
      parsed.intent === 'alert' &&
      /\b(?:ssl|site|domain|hosting|server|dns)\b/i.test(parsed.raw),
    template: (parsed) => ({
      title: parsed.suggestedTitle || 'Site issue detected',
      description: parsed.raw,
      priority: 'critical',
      tags: [...inferTags(parsed), 'type:infrastructure'],
      source: parsed.meta.source,
    }),
  },
  {
    name: 'seo_task',
    match: (parsed) =>
      parsed.entities.tools &&
      parsed.entities.tools.some(t => ['SEO Neo', 'GMB'].includes(t)),
    template: (parsed) => ({
      title: parsed.suggestedTitle || `SEO task: ${parsed.entities.tools.join(', ')}`,
      description: parsed.raw,
      tags: [...inferTags(parsed), 'type:seo'],
      source: parsed.meta.source,
    }),
  },
  {
    name: 'build_feature',
    match: (parsed) =>
      parsed.intent === 'create_task' &&
      parsed.entities.tools &&
      parsed.entities.tools.includes('ACC'),
    template: (parsed) => ({
      title: parsed.suggestedTitle || 'ACC feature build',
      description: parsed.raw,
      tags: [...inferTags(parsed), 'type:feature'],
      source: parsed.meta.source,
    }),
  },
];

function matchTemplate(parsed) {
  for (const t of TASK_TEMPLATES) {
    if (t.match(parsed)) {
      return { name: t.name, ...t.template(parsed) };
    }
  }
  return null;
}

// ── Completion Detection (Task 102) ─────────────────────

/**
 * Detect if a message signals task completion.
 * Returns { taskIds: number[], targetStatus: string } or null.
 */
function detectCompletion(parsed) {
  // Only update_status intent triggers completion — directives are "go do this", not "this is done"
  if (parsed.intent !== 'update_status') return null;

  const targetStatus = parsed.entities.target_status;
  if (!targetStatus) return null;

  const taskIds = parsed.entities.task_refs;
  if (!taskIds || taskIds.length === 0) return null;

  return {
    taskIds,
    targetStatus,
    confidence: parsed.confidence,
  };
}

// ── Main Rules Application ──────────────────────────────

/**
 * Apply all rules to a parsed event. Returns an enriched event
 * with recommended actions.
 *
 * @param {Object} parsed — Output from parser.parse()
 * @returns {Object} enriched event with actions
 */
function apply(parsed) {
  const result = {
    ...parsed,
    priority: inferPriority(parsed),
    tags: inferTags(parsed),
    template: matchTemplate(parsed),
    completion: detectCompletion(parsed),
    actions: [],
  };

  // ── Determine actions to take ──

  // Action: Create a task
  if (result.action === 'create' && result.confidence >= 0.6) {
    const taskData = result.template || {
      title: result.suggestedTitle || result.raw.substring(0, 120),
      description: result.raw,
      tags: result.tags,
      source: result.meta.source,
    };
    result.actions.push({
      type: 'create_task',
      data: {
        ...taskData,
        priority: result.priority,
      },
      confidence: result.confidence,
    });
  }

  // Action: Update task status
  if (result.completion) {
    result.actions.push({
      type: 'update_task_status',
      data: {
        taskIds: result.completion.taskIds,
        status: result.completion.targetStatus,
      },
      confidence: result.completion.confidence,
    });
  }

  // Action: Start tasks (directive with task refs = move to in_progress)
  if (result.intent === 'directive' && result.entities.task_refs && result.entities.task_refs.length > 0) {
    result.actions.push({
      type: 'update_task_status',
      data: {
        taskIds: result.entities.task_refs,
        status: 'in_progress',
      },
      confidence: result.confidence,
    });
  }

  // Action: Search for tasks (question intent)
  if (result.action === 'search' || result.action === 'lookup') {
    result.actions.push({
      type: 'search_tasks',
      data: {
        taskIds: result.entities.task_refs || null,
        query: result.raw,
      },
      confidence: result.confidence,
    });
  }

  // Action: Fuzzy status update (mentioned completion but no task ID)
  if (result.action === 'search_and_update' && result.entities.target_status) {
    result.actions.push({
      type: 'fuzzy_status_update',
      data: {
        targetStatus: result.entities.target_status,
        searchHints: {
          niches: result.entities.niches,
          tools: result.entities.tools,
          markets: result.entities.markets,
          query: result.raw,
        },
      },
      confidence: result.confidence * 0.7,  // Lower confidence for fuzzy matches
    });
  }

  return result;
}

// ── Full Pipeline ───────────────────────────────────────

/**
 * Full pipeline: raw message → parsed → rules applied → enriched event.
 *
 * @param {string} text — Raw message
 * @param {Object} meta — { source, sender, timestamp, channel }
 * @returns {Object} fully enriched event with actions
 */
function process(text, meta = {}) {
  const parsed = parse(text, meta);
  return apply(parsed);
}

module.exports = {
  apply,
  process,
  inferPriority,
  inferTags,
  matchTemplate,
  detectCompletion,
  PRIORITY_RULES,
  TASK_TEMPLATES,
};
