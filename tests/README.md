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

Every endpoint gets: the 401 case (no token, where auth is required),
the 403 case (wrong role, or wrong owner for anything ownership-scoped
— a customer hitting another customer's booking/device/ticket/etc.),
and at least one happy path. Payment-gated endpoints (bookings,
shipments) also cover the Paystack verification failure path. File
upload endpoints (articles, DIY videos) are tested without an actual
file attached — that's enough to cover the auth/validation/DB logic;
the Cloudinary upload step itself is third-party plumbing and isn't
exercised here.

## Adding a new test

1. `const { app, db, authHeader } = require("../helpers/testApp");`
2. `beforeEach(() => db.__reset())`
3. Queue up `db.query.mockResolvedValueOnce(...)` once per query the
   handler will make, in call order — check the controller if unsure.
4. `request(app).get("/api/whatever").set("Authorization", authHeader({ role: "..." }))`
