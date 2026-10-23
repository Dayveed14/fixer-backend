# API endpoint tests

Every route in `routes/` has a matching file under `tests/routes/`, one
per resource, run with Jest + Supertest against the real Express app
(no server actually listening — Supertest drives it in-process).

## Running

```
npm install
npm test              # run everything
npm test -- Booking   # run just tests/routes/Booking.route.test.js
npm run test:coverage # same, with a coverage table for controllers/routes
```

No real database, email provider, payment gateway, MeshCentral, or AI
service is ever touched. Nothing here needs `.env` values beyond what
`tests/helpers/env.js` sets automatically before any test runs.

## How it's wired

- **`config/__mocks__/db.js`** — a manual Jest mock standing in for the
  mysql2 pool. `db.query` resolves to `[[]]` by default; each test
  overrides it per-call with `db.query.mockResolvedValueOnce([rows])`,
  in the order the controller under test actually issues its queries.
  `db.getConnection()` also works, for the one transactional flow in
  `Booking.Controller.assignTechnician` — use `db.mockConnection.query`
  for that instead of `db.query`. Call `db.__reset()` in a
  `beforeEach` (every test file here already does).

- **`services/__mocks__/*.js`** — manual mocks for `mailService`,
  `notificationService`, `meshCentralService`, `paystackService`, and
  `gemini`. All resolve successfully by default; override with
  `.mockRejectedValueOnce(...)` to test a failure path (see the
  Paystack/Resend examples in `Booking.route.test.js` and
  `Contact.route.test.js`).

- **`tests/helpers/testApp.js`** — import this first in any new test
  file. It registers all the `jest.mock(...)` calls above, then
  requires `app.js` (which is what actually wires the mocks into
  every controller), and exports:
  - `app` — pass straight to `supertest(app)`
  - `db` — the mocked db, for setting up query results
  - `authHeader({ id, email, role })` — returns a ready-to-use
    `Authorization: Bearer <token>` value signed the same way login
    does, so `verifyToken`/`authorize` in `middleware/auth.js` accept
    it exactly like a real session.

## What's covered

Tests are grouped by the priorities they protect:

| Folder | Priority | What it proves |
|---|---|---|
| `tests/security/` | 1 — auth & authorization | Every protected endpoint 401s without a session, with a forged/expired/`alg=none` token, and 403s for the wrong role (one table in `authMatrix.test.js`); record ownership / ID manipulation (`ownership.test.js`); rate limits actually trip (`rateLimit.test.js`). |
| `tests/payments/` | 2 — payments | Server-side pricing at initialisation; Paystack verification; wrong amount/currency; failed/abandoned/reversed/pending states; Paystack outage leaves the payment pending; duplicate references return the existing record; DB failures roll back; another user's payment is refused; webhook signature, replays and amount mismatches; who can read payment records. |
| `tests/workflows/` + `tests/routes/` | 3 — core workflows | Register → login → pay → book → assign → resolve → rate, plus per-endpoint tests for bookings, tickets, shipments, ratings, devices, etc. |
| `tests/fixbot/` | 4 — FixBot | Knowledge-base match; no match → AI; AI failure, timeout and malformed output degrade to a `no_match` answer; per-caller and global AI budgets; identity only from verified sessions; input size/shape limits. |
| `tests/deployment/` + `tests/unit/env.test.js` | 5 — deployment | Health/readiness checks, JSON 404/400/413 handling, CORS, app import has no side effects, environment validation, Paystack client timeouts. |
| `tests/unit/` | — | Pure logic: Abuja zone pricing, 8 AM–10 PM slot rules in Abuja time, AI output normalisation, Paystack client. |

The frontend production build is checked in the frontend repo
(`npm run build`), alongside its own Vitest suite.

### Helpers

- `tests/helpers/sqlRouter.js` — `routeQueries(db.query, [[/regex/, result], ...])`
  answers mocked queries by SQL text instead of call order. Use it for
  flows that issue many queries (payments).
- `tests/helpers/dates.js` — `tomorrow()`, `yesterday()`, `daysFromNow(n)`
  in Abuja time, so date-based tests never go stale.
- Rate limits are set very high for every test file by
  `tests/helpers/env.js`; `tests/security/rateLimit.test.js` sets its
  own low values before loading the app.

## Adding a new test

1. `const { app, db, authHeader } = require("../helpers/testApp");`
2. `beforeEach(() => db.__reset())`
3. Queue up `db.query.mockResolvedValueOnce(...)` once per query the
   handler will make, in call order — check the controller if unsure.
4. `request(app).get("/api/whatever").set("Authorization", authHeader({ role: "..." }))`

## Integration tests (real database)

`tests/integration/*.int.test.js` run the real app against a fresh MySQL/MariaDB
database built from `db/schema.sql` + `migrations/` (see `jest.integration.config.js`).
Only Paystack, email, AI and MeshCentral are faked. They cover concurrent
payment submissions, webhook replays and races, rollback on failure, the whole
repair lifecycle, approve/decline races, sessions and password changes, admin
user management, every dashboard query, and migration rollbacks.

    DB_HOST=127.0.0.1 DB_USER=root DB_PASSWORD=secret npm run test:integration
