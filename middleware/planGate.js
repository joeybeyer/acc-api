/**
 * Feature-gating middleware with freemium tier system.
 *
 * Enforces plan limits:
 *   trial    → Pro-level features for 30 days (unlimited tasks, creative loop, 3 API keys, full activity)
 *   free     → 10 tasks/month, 1 API key, no creative loop, 7-day activity feed 
 *   starter  → 500 tasks/month, 2 API keys, no creative loop, 30-day activity feed
 *   pro      → 2000 tasks/month, 5 API keys, creative loop, full activity feed
 *   agency   → unlimited everything, white-label
 *
 * Trial users get Pro-level access for 30 days.
 * Expired trials with no subscription → drop to free tier (not locked out).
 * Admins bypass all gates.
 */
const { getDb } = require('../db');

const PLAN_LIMITS = {
  trial:   { tasks_per_month: Infinity, api_keys: 3,  creative_loop: true,  whitelabel: false, activity_feed_days: null, team_members: 3 },
  free:    { tasks_per_month: 10,       api_keys: 1,  creative_loop: false, whitelabel: false, activity_feed_days: 7,    team_members: 1 },
  starter: { tasks_per_month: 500,      api_keys: 2,  creative_loop: false, whitelabel: false, activity_feed_days: 30,   team_members: 2 },
  pro:     { tasks_per_month: 2000,     api_keys: 5,  creative_loop: true,  whitelabel: false, activity_feed_days: null, team_members: 5 },
  agency:  { tasks_per_month: Infinity, api_keys: 25, creative_loop: true,  whitelabel: true,  activity_feed_days: null, team_members: Infinity },
};

/**
 * Determine user's effective plan based on trial/subscription status
 */
function getEffectivePlan(user) {
  // Active trial = pro-level access
  if (user.trial_ends_at) {
    const trialEnd = new Date(user.trial_ends_at + 'Z');
    if (trialEnd > new Date()) return 'trial'; // treated as pro
  }
  // Has subscription = use their plan
  if (user.stripe_subscription_id) return user.plan;
  // Expired trial, no sub = free
  return 'free';
}

/**
 * Check if user's trial/subscription is active.
 * Returns { active: bool, reason: string, effectivePlan: string }
 */
function checkAccess(user) {
  // Admins always have access
  if (user.is_admin) return { active: true, effectivePlan: user.plan || 'agency' };

  const effectivePlan = getEffectivePlan(user);

  // All plans (including free) are active - users don't get locked out
  // They just get limited features on free tier
  return { active: true, effectivePlan };
}

/**
 * Factory: returns middleware that checks a specific feature/limit.
 *
 * Usage:
 *   router.post('/tasks', planGate('create_task'), handler)
 *   router.post('/api-keys', planGate('create_api_key'), handler)
 *   router.use('/creative-loop', planGate('creative_loop'))
 */
function planGate(feature) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Admins bypass everything
    if (user.is_admin) return next();

    const access = checkAccess(user);
    const effectivePlan = access.effectivePlan;
    const limits = PLAN_LIMITS[effectivePlan] || PLAN_LIMITS.free;
    const db = getDb();

    switch (feature) {
      case 'create_task': {
        // Count tasks created this month
        const count = db.prepare(`
          SELECT COUNT(*) as cnt FROM tasks
          WHERE user_id = ?
          AND created_at >= datetime('now', 'start of month')
        `).get(user.id).cnt;

        if (count >= limits.tasks_per_month) {
          const isFreeTier = effectivePlan === 'free';
          const upgradeHint = isFreeTier 
            ? 'Upgrade to Starter plan for 500 tasks/month.'
            : effectivePlan === 'starter'
            ? 'Upgrade to Pro for 2,000 tasks/month.'
            : null;

          return res.status(403).json({
            error: 'PlanLimitReached',
            message: `Your ${effectivePlan} plan allows ${limits.tasks_per_month} tasks/month. You've used ${count}.`,
            current: count,
            limit: limits.tasks_per_month,
            upgrade_hint: upgradeHint,
          });
        }
        break;
      }

      case 'create_api_key': {
        const count = db.prepare(
          'SELECT COUNT(*) as cnt FROM api_keys WHERE user_id = ?'
        ).get(user.id).cnt;

        if (count >= limits.api_keys) {
          return res.status(403).json({
            error: 'PlanLimitReached',
            message: `Your ${effectivePlan} plan allows ${limits.api_keys} API key(s). You have ${count}.`,
            current: count,
            limit: limits.api_keys,
          });
        }
        break;
      }

      case 'creative_loop': {
        if (!limits.creative_loop) {
          return res.status(403).json({
            error: 'PlanLimitReached',
            message: 'Creative Loop requires Pro or Agency plan.',
          });
        }
        break;
      }

      case 'whitelabel': {
        if (!limits.whitelabel) {
          return res.status(403).json({
            error: 'PlanLimitReached',
            message: 'White-label requires Agency plan.',
          });
        }
        break;
      }

      // Generic write gate - now all plans can write (free is just limited)
      case 'write': {
        // All users can write, just with different limits
        break;
      }

      default:
        break;
    }

    // Add effective plan to request for other middlewares
    req.effectivePlan = effectivePlan;
    next();
  };
}

module.exports = { planGate, checkAccess, getEffectivePlan, PLAN_LIMITS };