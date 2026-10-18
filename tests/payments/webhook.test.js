// POST /api/payments/webhook — signature, idempotency, repeated delivery.
const crypto = require("crypto");
const request = require("supertest");
const { app, db } = require("../helpers/testApp");
const { routeQueries, callsMatching } = require("../helpers/sqlRouter");

const sign = (raw) =>
  crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");

const event = (overrides = {}) => ({
  event: "charge.success",
  data: { reference: "FXB_1", amount: 500000, currency: "NGN", id: 42, channel: "card", ...overrides },
});

function deliver(payload, signature) {
  const raw = JSON.stringify(payload);
  return request(app)
    .post("/api/payments/webhook")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signature === undefined ? sign(raw) : signature)
    .send(raw);
}

const row = (status = "pending") => ({
  reference: "FXB_1",
  status,
  amount_kobo: 500000,
  currency: "NGN",
});

beforeEach(() => db.__reset());

it("401s a missing signature", async () => {
  const res = await request(app).post("/api/payments/webhook").send(event());
  expect(res.status).toBe(401);
  expect(db.query).not.toHaveBeenCalled();
});

it("401s a forged signature", async () => {
  const res = await deliver(event(), "f".repeat(128));
  expect(res.status).toBe(401);
  expect(db.query).not.toHaveBeenCalled();
});

it("401s when the body was altered after signing", async () => {
  const signature = sign(JSON.stringify(event()));
  const res = await deliver(event({ amount: 1 }), signature);
  expect(res.status).toBe(401);
});

it("marks a pending payment as success and audits it as a webhook change", async () => {
  routeQueries(db.query, [[/SELECT \* FROM payment_transactions/, [[row()]]]]);

  const res = await deliver(event());

  expect(res.status).toBe(200);
  expect(res.body.outcome).toBe("marked_success");
  const [update] = callsMatching(db.query, /UPDATE payment_transactions/);
  expect(update[1]).toEqual(expect.arrayContaining(["success", "FXB_1", "pending"]));
  const [audit] = callsMatching(db.query, /INSERT INTO payment_events/);
  expect(audit[1]).toEqual(expect.arrayContaining(["status_changed", "pending", "success", "webhook"]));
});

it("is a no-op on repeated delivery of the same event", async () => {
  routeQueries(db.query, [[/SELECT \* FROM payment_transactions/, [[row("success")]]]]);

  const first = await deliver(event());
  const second = await deliver(event());

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(second.body.outcome).toBe("already_success");
  expect(callsMatching(db.query, /UPDATE payment_transactions/)).toHaveLength(0);
});

it("does not double-apply if another process changed the row first", async () => {
  routeQueries(db.query, [
    [/SELECT \* FROM payment_transactions/, [[row()]]],
    [/UPDATE payment_transactions/, [{ affectedRows: 0 }]],
  ]);
  const res = await deliver(event());
  expect(res.body.outcome).toBe("no_change");
  expect(callsMatching(db.query, /INSERT INTO payment_events/)).toHaveLength(0);
});

it("flags an amount mismatch instead of marking success", async () => {
  routeQueries(db.query, [[/SELECT \* FROM payment_transactions/, [[row()]]]]);
  const res = await deliver(event({ amount: 100 }));
  expect(res.body.outcome).toBe("marked_mismatch");
});

it("200s and ignores unknown references and other events", async () => {
  const unknown = await deliver(event({ reference: "NOPE" }));
  expect(unknown.status).toBe(200);
  expect(unknown.body.outcome).toBe("unknown_reference");

  const other = await deliver({ event: "transfer.success", data: {} });
  expect(other.body.outcome).toBe("ignored_event");
});

it("500s on a DB error so Paystack retries later", async () => {
  db.query.mockRejectedValueOnce(new Error("db down"));
  const res = await deliver(event());
  expect(res.status).toBe(500);
});
