# Fixer API

Backend for [fixerng.app](https://fixerng.app): accounts and sessions, paid
support calls (voice, video, remote desktop), device pickup and repair across
Abuja with a quote/approval flow, Paystack payments, FixBot diagnosis, articles
and DIY videos. Node 20 + Express 5 + MySQL, deployed on Render.

Frontend: [fixer-vite](https://github.com/Dayveed14/fixer-vite).
Operations (backups, rollback, alerts): [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Run it locally

```bash
npm ci
cp .env.example .env          # fill in DB_* and the keys you have
# local MySQL/MariaDB without TLS: add DB_SSL=false
npm run db:setup              # creates the database: db/schema.sql + migrations/
npm run dev                   # http://localhost:4000, restarts on changes
```

| Command | What it does |
| --- | --- |
| `npm start` | Production start (`node app.js`) |
| `npm run dev` | Development with nodemon |
| `npm test` | Unit + route tests (database mocked), ~800 tests |
| `npm run test:integration` | Real-database tests: payments, concurrency, sessions, migrations (needs MySQL/MariaDB, see below) |
| `npm run db:setup` | Create the database from `db/schema.sql` + every migration (`-- --reset` to rebuild) |
| `npm run db:backup` / `db:restore` / `db:verify-restore` | Backups — see `docs/OPERATIONS.md` |

### Integration tests

They build a throwaway database (`fixer_integration`) and run the real app
against it. Point them at any MySQL 8 / MariaDB 10.11+ you can create databases on:

```bash
DB_HOST=127.0.0.1 DB_USER=root DB_PASSWORD=secret npm run test:integration
```

CI runs them on both MySQL 8.0 and MariaDB 10.11.

## Configuration

Every variable is listed in `.env.example`. In production the server refuses
to start without: `JWT_SECRET` (32+ chars), `DB_HOST`, `DB_USER`,
`DB_PASSWORD`, `DB_NAME`, `PAYSTACK_SECRET_KEY`, `RESEND_API_KEY`.

## How it fits together

```
app.js              Express app: CORS allowlist, JSON limits, CSRF guard,
                    request monitoring, routes, error handler, graceful shutdown
routes/             One file per area, mounted under /api/<area>
controllers/        Request handling
services/           paymentService (Paystack verify/fulfil/webhook), pricingService,
                    shipmentLifecycle, meetingService (Meet/Jitsi), sessionService,
                    monitor (alerts), mailService (Resend), aiGuard (FixBot limits)
middleware/         auth (sessions/roles), rateLimit, upload (+ Cloudinary)
utils/validate.js   Shared input rules (email, password, lengths, slugs, limits)
db/schema.sql       Base tables;  migrations/  dated changes (+ rollback/)
scripts/            db-setup, backup/restore/verify, debug tools
```

### Sessions and roles

- Login sets an httpOnly cookie (`fixer_token`, 1 day). A Bearer header also works
  for non-browser clients.
- Every request re-checks the account (cached 60 s): deleted accounts, changed
  roles and old sessions after a password change are rejected.
- `PATCH /api/users/me/password` (any role) checks the current password, signs
  out every other session and emails a security notice.
- Roles: `user` (customer), `technician`, `admin`. Customers and technicians
  only ever see their own records; admin-only routes use `authorize("admin")`.
- Browser requests that change data must send `X-Fixer-Client: web` (CSRF guard).

### Payments (Paystack)

1. `POST /api/payments/initialize` — the server prices the request (booking,
   pickup, repair quote, return delivery) and records a pending payment.
2. The customer pays in the Paystack popup.
3. The booking/shipment/approval request includes the reference; the server
   verifies it with Paystack, checks amount, currency, owner and details, then
   creates the record in one transaction. A payment can be used exactly once.
4. `POST /api/payments/webhook` (signed by Paystack) marks payments paid even if
   the customer's browser closed. Safe to receive any number of times.

Paid-but-unused payments and amount mismatches raise alerts (see Operations).

## API overview

| Area | Base path | Notes |
| --- | --- | --- |
| Accounts | `/api/users` | register, login, logout, me, change password; admin: list/create/edit/delete |
| Bookings | `/api/bookings` | support types & slots (public), book (paid), assign, status, meeting links |
| Shipments | `/api/shipments` | zones & slots (public), pickup (paid), quote, approve/decline, repair result, delivery |
| Payments | `/api/payments` | initialize, status, webhook; admin list + audit trail |
| Pricing | `/api/pricing` | admin: support prices, pickup zones, settings |
| Tickets, devices, ratings, notifications, stats | `/api/…` | dashboards |
| Content | `/api/articles`, `/api/diy-videos` | public: published only; admin: manage |
| FixBot | `/api/diagnosis/run` | knowledge base first, AI fallback with limits |
| Health | `/api/health`, `/api/health/ready`, `/api/health/metrics` (admin) | |

## Deploying (Render)

- Build: `npm ci` · Start: `npm start` · Health check path: `/api/health`
- Node 20+. Apply new files in `migrations/` **before** deploying code that needs them.
- Paystack dashboard → Settings → API Keys & Webhooks → webhook URL
  `https://<render-host>/api/payments/webhook`.
- CI (`.github/workflows/ci.yml`) runs unit tests, integration tests on MySQL 8
  and MariaDB, a backup/restore check and a production start-up check on every push.
