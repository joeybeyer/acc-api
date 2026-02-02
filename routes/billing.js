/**
 * Billing routes — Stripe integration.
 *
 * - POST /stripe/webhook     → handle Stripe events (raw body, signature verified)
 * - POST /billing/checkout   → create Stripe Checkout session
 * - GET  /billing/portal     → create Stripe Customer Portal session
 */
const { Router } = require('express');
const { getDb } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = Router();

// ── Stripe client (lazy init) ───────────────────────

let stripe = null;

function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'sk_test_xxx') {
      return null; // Stripe not configured
    }
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

const PRICE_MAP = {
  starter: process.env.STRIPE_PRICE_STARTER,
  pro: process.env.STRIPE_PRICE_PRO,
  agency: process.env.STRIPE_PRICE_AGENCY,
};

// ── POST /stripe/webhook ────────────────────────────
// NOTE: this route uses express.raw() — mounted separately in server.js

router.post('/stripe/webhook', (req, res) => {
  const s = getStripe();
  if (!s) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = s.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const db = getDb();

  try {
    switch (event.type) {
      // ── Subscription created ─────────────────────
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const status = sub.status; // active, trialing, past_due, canceled, etc.

        // Determine plan from price
        const priceId = sub.items?.data?.[0]?.price?.id;
        let plan = 'starter';
        if (priceId === PRICE_MAP.pro) plan = 'pro';
        else if (priceId === PRICE_MAP.agency) plan = 'agency';

        const user = db.prepare(
          'SELECT id FROM users WHERE stripe_customer_id = ?'
        ).get(customerId);

        if (user) {
          const isActive = ['active', 'trialing'].includes(status) ? 1 : 0;
          db.prepare(`
            UPDATE users
            SET plan = ?, stripe_subscription_id = ?, is_active = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(plan, sub.id, isActive, user.id);

          console.log(`Stripe: user ${user.id} → ${plan} (${status})`);
        } else {
          console.warn(`Stripe: no user found for customer ${customerId}`);
        }
        break;
      }

      // ── Subscription deleted ─────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;

        const user = db.prepare(
          'SELECT id FROM users WHERE stripe_customer_id = ?'
        ).get(customerId);

        if (user) {
          db.prepare(`
            UPDATE users
            SET stripe_subscription_id = NULL, updated_at = datetime('now')
            WHERE id = ?
          `).run(user.id);
          console.log(`Stripe: subscription deleted for user ${user.id}`);
        }
        break;
      }

      // ── Payment failed ───────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        const user = db.prepare(
          'SELECT id FROM users WHERE stripe_customer_id = ?'
        ).get(customerId);

        if (user) {
          // Log it — could also send notification
          db.prepare(`
            INSERT INTO activity_log (user_id, action, message, metadata)
            VALUES (?, 'payment_failed', 'Subscription payment failed', ?)
          `).run(user.id, JSON.stringify({
            invoice_id: invoice.id,
            amount: invoice.amount_due,
            attempt_count: invoice.attempt_count,
          }));
          console.log(`Stripe: payment failed for user ${user.id}`);
        }
        break;
      }

      // ── Checkout completed ───────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;

        // Link Stripe customer to our user via metadata
        if (session.metadata?.user_id) {
          db.prepare(`
            UPDATE users
            SET stripe_customer_id = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(session.customer, session.metadata.user_id);
          console.log(`Stripe: linked customer ${session.customer} → user ${session.metadata.user_id}`);
        }
        break;
      }

      default:
        console.log(`Stripe: unhandled event type ${event.type}`);
    }
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    // Return 200 anyway — Stripe will retry on 5xx
  }

  res.json({ received: true });
});

// ── POST /billing/checkout ──────────────────────────
// Create a Stripe Checkout session for the authenticated user.

router.post('/checkout', authenticate, async (req, res) => {
  try {
    const s = getStripe();
    if (!s) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    const { plan } = req.body;
    const priceId = PRICE_MAP[plan];

    if (!priceId) {
      return res.status(400).json({
        error: 'ValidationError',
        message: `Invalid plan. Choose: starter, pro, or agency`,
      });
    }

    const db = getDb();
    const appUrl = process.env.APP_URL || 'http://localhost:3000';

    // Create or reuse Stripe customer
    let customerId = req.user.stripe_customer_id;
    if (!customerId) {
      const customer = await s.customers.create({
        email: req.user.email,
        name: req.user.name,
        metadata: { user_id: String(req.user.id) },
      });
      customerId = customer.id;
      db.prepare(
        `UPDATE users SET stripe_customer_id = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(customerId, req.user.id);
    }

    const session = await s.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { user_id: String(req.user.id) },
      },
      success_url: `${appUrl}?checkout=success`,
      cancel_url: `${appUrl}?checkout=cancel`,
      metadata: { user_id: String(req.user.id) },
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ── GET /billing/portal ─────────────────────────────
// Create a Stripe Customer Portal session.

router.get('/portal', authenticate, async (req, res) => {
  try {
    const s = getStripe();
    if (!s) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    if (!req.user.stripe_customer_id) {
      return res.status(400).json({
        error: 'NoBillingAccount',
        message: 'No billing account found. Subscribe to a plan first.',
      });
    }

    const appUrl = process.env.APP_URL || 'http://localhost:3000';

    const session = await s.billingPortal.sessions.create({
      customer: req.user.stripe_customer_id,
      return_url: `${appUrl}/settings`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

module.exports = router;
