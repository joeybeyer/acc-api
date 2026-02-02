/**
 * Creative Loop Engine — Diagnosis Service
 *
 * Takes ad metrics (current + previous snapshots) and user-configured
 * thresholds, then returns a structured diagnosis with exactly one
 * recommended action.
 *
 * Diagnosis actions:
 *   swap_hook         — CTR too low → hook isn't stopping the scroll
 *   add_trust         — CTR ok but CPA high → people click but don't convert
 *   change_recipe     — Frequency high + CTR declining → ad fatigue
 *   improve_relevance — CPC too high → relevance problem
 *   scale             — CTR high + CPA low → WINNER
 *   pause             — Spending without results → cut losses
 *
 * Usage:
 *   const { diagnose } = require('../services/diagnosis');
 *   const result = diagnose(currentMetrics, previousMetrics, config);
 */

// ── Default thresholds (overridden per-user via loop_configs) ──

const DEFAULT_CONFIG = {
  ctr_low_threshold: 1.0,       // CTR below this = hook problem
  ctr_winner_threshold: 2.0,    // CTR above this = potential winner
  cpa_target: 50.0,             // Target cost per acquisition
  cpc_multiplier: 2.0,          // CPC > avg * this = relevance problem
  frequency_fatigue: 3.0,       // Frequency above this = fatigue territory
  ctr_decline_pct: 20.0,        // CTR drop % that signals fatigue
};

// ── Severity levels ──

const SEVERITY = {
  CRITICAL: 'critical',   // Hemorrhaging budget, act now
  HIGH: 'high',           // Clear problem, should fix soon
  MEDIUM: 'medium',       // Underperforming, could improve
  LOW: 'low',             // Minor optimization opportunity
  POSITIVE: 'positive',   // Good news — winner detected
};

/**
 * Calculate the percentage change between two values.
 * Returns null if previous is 0 or undefined.
 */
function pctChange(current, previous) {
  if (!previous || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Compute an average CPC from metric snapshots for comparison.
 * If no snapshots provided, returns null.
 */
function computeAverageCpc(snapshots) {
  if (!snapshots || snapshots.length === 0) return null;
  const cpcs = snapshots.filter(s => s.cpc != null && s.cpc > 0).map(s => s.cpc);
  if (cpcs.length === 0) return null;
  return cpcs.reduce((a, b) => a + b, 0) / cpcs.length;
}

/**
 * Main diagnosis function.
 *
 * @param {Object} metrics          — Current metrics { ctr, cpa, cpc, cpm, frequency, impressions, clicks, conversions, spend }
 * @param {Object|null} previous    — Previous snapshot metrics (same shape) for trend analysis
 * @param {Object} config           — User thresholds (merged with defaults)
 * @param {Array} [snapshots=[]]    — Historical snapshots for average calculations
 * @returns {Object} { problem, severity, action, suggestion, details }
 */
function diagnose(metrics, previous = null, config = {}, snapshots = []) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Bail early if no meaningful data
  if (!metrics || metrics.impressions == null || metrics.impressions < 100) {
    return {
      problem: 'Insufficient data',
      severity: SEVERITY.LOW,
      action: 'wait',
      suggestion: 'Not enough impressions to diagnose. Wait for at least 100 impressions before analyzing.',
      details: { impressions: metrics?.impressions || 0, minimum: 100 },
    };
  }

  const ctr = metrics.ctr ?? (metrics.clicks / metrics.impressions * 100);
  const cpa = metrics.cpa ?? (metrics.conversions > 0 ? metrics.spend / metrics.conversions : null);
  const cpc = metrics.cpc ?? (metrics.clicks > 0 ? metrics.spend / metrics.clicks : null);
  const frequency = metrics.frequency ?? null;

  // Track all detected issues, then return the most severe
  const issues = [];

  // ── Check 1: WINNER detection (check first — good news shouldn't be buried) ──
  if (ctr >= cfg.ctr_winner_threshold && cpa !== null && cpa <= cfg.cpa_target) {
    issues.push({
      problem: 'Winner detected',
      severity: SEVERITY.POSITIVE,
      action: 'scale',
      suggestion: `CTR ${ctr.toFixed(2)}% exceeds ${cfg.ctr_winner_threshold}% target and CPA $${cpa.toFixed(2)} is under $${cfg.cpa_target} target. Scale this ad — increase budget or duplicate to new audiences.`,
      details: { ctr, cpa, ctr_threshold: cfg.ctr_winner_threshold, cpa_target: cfg.cpa_target },
      priority: 0,
    });
  }

  // ── Check 2: Ad Fatigue (frequency high + CTR declining) ──
  if (frequency !== null && frequency >= cfg.frequency_fatigue && previous) {
    const prevCtr = previous.ctr ?? (previous.clicks / previous.impressions * 100);
    const ctrDelta = pctChange(ctr, prevCtr);

    if (ctrDelta !== null && ctrDelta <= -cfg.ctr_decline_pct) {
      issues.push({
        problem: 'Ad fatigue',
        severity: SEVERITY.HIGH,
        action: 'change_recipe',
        suggestion: `Frequency ${frequency.toFixed(1)} is above ${cfg.frequency_fatigue} and CTR dropped ${Math.abs(ctrDelta).toFixed(1)}%. Audience is seeing this too often. Change the visual recipe (subject, setting, composition) while keeping the wrapper/format that works.`,
        details: { frequency, ctr, prevCtr, ctrDelta, threshold: cfg.frequency_fatigue },
        priority: 1,
      });
    }
  }

  // ── Check 3: Hook problem (CTR too low) ──
  if (ctr < cfg.ctr_low_threshold) {
    // Determine severity based on how far below threshold
    const severity = ctr < cfg.ctr_low_threshold * 0.5 ? SEVERITY.CRITICAL : SEVERITY.HIGH;

    issues.push({
      problem: 'Low CTR — hook not stopping the scroll',
      severity,
      action: 'swap_hook',
      suggestion: `CTR ${ctr.toFixed(2)}% is below ${cfg.ctr_low_threshold}% minimum. The ad isn't grabbing attention. Swap the hook: change the opening line, headline, or the first visual element people see. Make the disruption pattern stronger.`,
      details: { ctr, threshold: cfg.ctr_low_threshold },
      priority: 2,
    });
  }

  // ── Check 4: Trust problem (CTR ok but CPA too high) ──
  if (ctr >= cfg.ctr_low_threshold && cpa !== null && cpa > cfg.cpa_target) {
    const overshoot = ((cpa - cfg.cpa_target) / cfg.cpa_target) * 100;
    const severity = overshoot > 100 ? SEVERITY.CRITICAL : overshoot > 50 ? SEVERITY.HIGH : SEVERITY.MEDIUM;

    issues.push({
      problem: 'Trust gap — clicking but not converting',
      severity,
      action: 'add_trust',
      suggestion: `CTR ${ctr.toFixed(2)}% is healthy but CPA $${cpa.toFixed(2)} is ${overshoot.toFixed(0)}% over $${cfg.cpa_target} target. People are interested but don't trust enough to convert. Add social proof, trust badges, testimonials, or authority signals.`,
      details: { ctr, cpa, cpa_target: cfg.cpa_target, overshoot_pct: overshoot },
      priority: 3,
    });
  }

  // ── Check 5: Relevance problem (CPC way too high) ──
  const avgCpc = computeAverageCpc(snapshots);
  if (cpc !== null && avgCpc !== null && cpc > avgCpc * cfg.cpc_multiplier) {
    issues.push({
      problem: 'Relevance problem — CPC too high',
      severity: SEVERITY.MEDIUM,
      action: 'improve_relevance',
      suggestion: `CPC $${cpc.toFixed(2)} is ${(cpc / avgCpc).toFixed(1)}x your average of $${avgCpc.toFixed(2)}. The platform is charging a premium because the ad doesn't match the audience. Make the core benefit obvious within 1 second. Tighten the message-to-audience fit.`,
      details: { cpc, avgCpc, multiplier: cfg.cpc_multiplier },
      priority: 4,
    });
  }

  // ── Check 6: Budget drain — spending with zero conversions ──
  if (metrics.spend > cfg.cpa_target * 2 && (metrics.conversions === 0 || metrics.conversions == null)) {
    issues.push({
      problem: 'Budget drain — spending with no conversions',
      severity: SEVERITY.CRITICAL,
      action: 'pause',
      suggestion: `Spent $${metrics.spend.toFixed(2)} (2x your CPA target) with zero conversions. Cut losses — pause this creative and analyze what's broken before iterating.`,
      details: { spend: metrics.spend, conversions: metrics.conversions || 0, cpa_target: cfg.cpa_target },
      priority: 1,
    });
  }

  // ── Return the highest-priority (most severe) issue ──
  if (issues.length === 0) {
    return {
      problem: 'Performing within thresholds',
      severity: SEVERITY.LOW,
      action: 'monitor',
      suggestion: 'Metrics are within acceptable ranges. No changes needed — continue monitoring.',
      details: { ctr, cpa, cpc, frequency },
    };
  }

  // Sort by priority (lower = more important), then by severity
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3, positive: 4 };
  issues.sort((a, b) => {
    // Winners always float to top if detected
    if (a.action === 'scale') return -1;
    if (b.action === 'scale') return 1;
    // Critical pauses next
    if (a.action === 'pause' && a.severity === SEVERITY.CRITICAL) return -1;
    if (b.action === 'pause' && b.severity === SEVERITY.CRITICAL) return 1;
    // Then by severity
    return (severityRank[a.severity] || 3) - (severityRank[b.severity] || 3);
  });

  const primary = issues[0];
  // Attach secondary issues for context
  if (issues.length > 1) {
    primary.secondary_issues = issues.slice(1).map(i => ({
      problem: i.problem,
      action: i.action,
      severity: i.severity,
    }));
  }

  return primary;
}

/**
 * Batch diagnose multiple creatives at once.
 * Returns Map<creativeId, diagnosis>.
 */
function diagnoseBatch(creativesWithMetrics, config = {}) {
  const results = new Map();
  for (const item of creativesWithMetrics) {
    results.set(item.id, diagnose(
      item.metrics,
      item.previousMetrics || null,
      config,
      item.snapshots || [],
    ));
  }
  return results;
}

module.exports = {
  diagnose,
  diagnoseBatch,
  DEFAULT_CONFIG,
  SEVERITY,
  pctChange,
  computeAverageCpc,
};
