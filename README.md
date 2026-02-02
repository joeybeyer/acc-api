# Activity Command Center — SaaS API v2.0

Multi-tenant rewrite of the Activity Command Center API. Drop-in replacement for the existing single-user server.

## Architecture

```
api/
├── server.js              Main Express app
├── package.json           Dependencies
├── .env                   Config (copy from .env.example)
├── db/
│   ├── index.js           DB connection singleton
│   ├── schema.js          Table definitions (fresh installs)
│   └── migrate.js         Migration script (existing DBs)
├── middleware/
│   ├── auth.js            Bearer token + API key auth
│   ├── admin.js           Admin-only gate
│   └── planGate.js        Plan limits & trial enforcement
└── routes/
    ├── auth.js            Signup, login, logout, me
    ├── tasks.js           Task CRUD (tenant-scoped)
    ├── activity.js        Activity feed (tenant-scoped)
    ├── admin.js           Platform management (admin only)
    ├── billing.js         Stripe webhooks + checkout + portal
    └── apiKeys.js         API key CRUD
```

## Quick Start (fresh install)

```bash
cd api/
cp .env.example .env
# Edit .env with your values
npm install
node server.js
```

Tables are created automatically on first run.

## Upgrading Existing Database

If you have an existing Activity Command Center with data:

```bash
cd /home/admin/activity-center/api/

# 1. Back up your database
cp ../db/tasks.db ../db/tasks.db.backup

# 2. Install new code (replace api/ directory)

# 3. Install dependencies
npm install

# 4. Set up env
cp .env.example .env
# Edit .env — set ADMIN_EMAIL, ADMIN_API_KEY, DATABASE_PATH, etc.

# 5. Run migration
node db/migrate.js
# → Creates users, api_keys, sessions tables
# → Creates admin user (Joey, user #1)
# → Maps existing API key to user #1
# → Assigns all existing tasks/activity to user #1
# → Safe to run multiple times (idempotent)

# 6. Restart server
pm2 restart activity-api
```

## Auth Methods

Two auth methods (checked in order):

1. **Bearer token** — `Authorization: Bearer <session_token>`
   - Obtained from POST /auth/login
   - 7-day expiry (configurable)
   - For dashboards and web clients

2. **API key** — `X-API-Key: <key>`
   - Created on signup or via POST /api-keys
   - No expiry (revoke manually)
   - For n8n, agents, automations

Both resolve to a user_id that scopes all queries.

## API Endpoints

### Public (no auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| POST | /auth/signup | Create account |
| POST | /auth/login | Get session token |

### Protected (auth required)

| Method | Path | Description |
|--------|------|-------------|
| POST | /auth/logout | Invalidate session |
| GET | /auth/me | Current user info |
| GET | /tasks | List tasks (filtered, paginated) |
| GET | /tasks/grouped | Tasks grouped by status (kanban) |
| GET | /tasks/:id | Get single task |
| POST | /tasks | Create task |
| PATCH | /tasks/:id | Update task |
| DELETE | /tasks/:id | Delete task |
| GET | /activity | Activity feed |
| POST | /activity | Log custom activity |
| GET | /stats | Dashboard stats |
| GET | /api-keys | List API keys |
| POST | /api-keys | Create API key |
| DELETE | /api-keys/:id | Revoke API key |
| POST | /billing/checkout | Start Stripe checkout |
| GET | /billing/portal | Open Stripe customer portal |

### Admin only (is_admin=1)

| Method | Path | Description |
|--------|------|-------------|
| GET | /admin/users | List all tenants |
| GET | /admin/users/:id | Tenant details + usage |
| PATCH | /admin/users/:id | Enable/disable, change plan |
| GET | /admin/stats | Platform-wide metrics |

### Stripe

| Method | Path | Description |
|--------|------|-------------|
| POST | /stripe/webhook | Stripe event handler |

## Multi-Tenant Scoping

All task and activity queries automatically filter by `user_id`. Users can only see their own data.

Admin users can add `?scope=all` to bypass scoping:
```
GET /tasks?scope=all        # admin sees all tenants' tasks
GET /activity?scope=all     # admin sees all activity
GET /stats?scope=all        # admin sees platform-wide stats
```

## Plans & Limits

| Feature | Starter ($49) | Pro ($149) | Agency ($499) |
|---------|:---:|:---:|:---:|
| Tasks/month | 100 | ∞ | ∞ |
| API keys | 1 | 5 | 25 |
| Webhooks | ✗ | ✓ | ✓ |
| White-label | ✗ | ✗ | ✓ |

14-day free trial on signup (starter features, no credit card required).

## Backward Compatibility

✅ Same port (3050)
✅ Same endpoints (/tasks, /activity, /stats)
✅ Same X-API-Key auth
✅ Same JSON response format
✅ Joey's existing API key keeps working (mapped to user #1)
✅ PHP proxy (`activity-api.php`) keeps working
✅ Existing dashboard keeps working

## Environment Variables

See `.env.example` for all available config.

| Variable | Required | Description |
|----------|:---:|-------------|
| PORT | ✗ | Server port (default: 3050) |
| HOST | ✗ | Bind address (default: 127.0.0.1) |
| DATABASE_PATH | ✗ | Path to SQLite DB (default: ../db/tasks.db) |
| ADMIN_EMAIL | ✗ | Admin user email for migration |
| ADMIN_API_KEY | ✗ | Existing API key to map during migration |
| LEGACY_API_KEY | ✗ | Fallback key (remove after migration) |
| STRIPE_SECRET_KEY | ✗ | Stripe API key (billing disabled if missing) |
| STRIPE_WEBHOOK_SECRET | ✗ | Stripe webhook verification |
| STRIPE_PRICE_* | ✗ | Stripe price IDs per plan |
| CORS_ORIGINS | ✗ | Comma-separated allowed origins |
| APP_URL | ✗ | Frontend URL for Stripe redirects |
| SESSION_EXPIRY_DAYS | ✗ | Session lifetime (default: 7) |
