// P0: payment initialisation → verification → fulfilment, webhook
// idempotency and concurrent requests, against a real database with
// real transactions and row locks. Only Paystack and email are faked.
jest.mock("../../services/paystackService");
jest.mock("../../services/mailService");
jest.mock("../../services/meshCentralService");
jest.mock("../../services/gemini");

const crypto = require("crypto");
const request = require("supertest");
const app = require("../../app");
const { verifyTransaction } = require("../../services/paystackService");
const { db, resetData, createUser, auth, count } = require("./helpers");
const { tomorrow } = require("../helpers/dates");

const DATE = tomorrow();

const paystackSays = (amountKobo, status = "success") =>
  verifyTransaction.mockResolvedValue({ status, currency: "NGN", amount: amountKobo, id: 4242, channel: "card" });

function signed(body) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
  return request(app)
    .post("/api/payments/webhook")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signature)
    .send(raw);
}

async function initBooking(user) {
  const res = await request(app)
    .post("/api/payments/initialize")
    .set("Authorization", auth(user))
    .send({ purpose: "booking", support_type: "voice", booking_date: DATE, booking_time: "10:00" });
  expect(res.status).toBe(201);
  return res.body;
}

const book = (user, reference, extra = {}) =>
  request(app)
    .post("/api/bookings")
    .set("Authorization", auth(user))
    .send({ support_type: "voice", booking_date: DATE, booking_time: "10:00", payment_reference: reference, issue_summary: "No boot", ...extra });

let ada;
beforeEach(async () => {
  await resetData();
  verifyTransaction.mockReset();
  ada = await createUser();
});

afterAll(() => db.end());

describe("booking payment, end to end", () => {
  it("prices from the database, verifies with Paystack and creates exactly one booking", async () => {
    const intent = await initBooking(ada);
    expect(intent.amount).toBe(5000); // seeded voice price

    const [[tx]] = await db.query("SELECT * FROM payment_transactions WHERE reference = ?", [intent.reference]);
    expect(tx).toMatchObject({ status: "pending", amount_kobo: 500000, user_id: ada.id, purpose: "booking" });

    paystackSays(500000);
    const res = await book(ada, intent.reference);

    expect(res.status).toBe(201);
    const [[after]] = await db.query("SELECT * FROM payment_transactions WHERE reference = ?", [intent.reference]);
    expect(after.status).toBe("success");
    expect(after.entity_type).toBe("booking");
    expect(after.entity_id).toBe(res.body.id);
    expect(after.fulfilled_at).not.toBeNull();
    expect(await count("bookings", "payment_reference = ?", [intent.reference])).toBe(1);

    const [events] = await db.query("SELECT event, to_status FROM payment_events WHERE reference = ? ORDER BY id", [intent.reference]);
    expect(events.map((e) => e.event)).toEqual(["created", "status_changed", "fulfilled"]);
  });

  it("10 simultaneous submissions of one payment → one booking, everyone gets the same id", async () => {
    const intent = await initBooking(ada);
    paystackSays(500000);

    const results = await Promise.all(Array.from({ length: 10 }, () => book(ada, intent.reference)));

    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await count("bookings")).toBe(1);
    expect(await count("payment_events", "reference = ? AND event = 'fulfilled'", [intent.reference])).toBe(1);
    expect(await count("payment_events", "reference = ? AND event = 'status_changed'", [intent.reference])).toBe(1);
  });

  it("refuses an underpayment and creates nothing", async () => {
    const intent = await initBooking(ada);
    paystackSays(100); // ₦1 instead of ₦5,000

    const res = await book(ada, intent.reference);

    expect(res.status).toBe(402);
    const [[tx]] = await db.query("SELECT status, failure_reason FROM payment_transactions WHERE reference = ?", [intent.reference]);
    expect(tx.status).toBe("mismatch");
    expect(tx.failure_reason).toMatch(/amount 100/);
    expect(await count("bookings")).toBe(0);
  });

  it("someone else can't redeem the payment", async () => {
    const intent = await initBooking(ada);
    const eve = await createUser();
    paystackSays(500000);

    const res = await book(eve, intent.reference);
    expect(res.status).toBe(403);
    expect(await count("bookings")).toBe(0);
  });

  it("can't change the slot after paying", async () => {
    const intent = await initBooking(ada);
    paystackSays(500000);
    const res = await book(ada, intent.reference, { booking_time: "15:00" });
    expect(res.status).toBe(409);
    expect(await count("bookings")).toBe(0);
  });

  it("rolls everything back if creating the booking fails part-way", async () => {
    const intent = await initBooking(ada);
    paystackSays(500000);
    // Make the booking insert fail inside the transaction (value too
    // long for the column): no booking, payment stays unredeemed.
    const res = await book(ada, intent.reference, { device: "x".repeat(5000) });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await count("bookings")).toBe(0);
    const [[tx]] = await db.query("SELECT status, entity_id FROM payment_transactions WHERE reference = ?", [intent.reference]);
    expect(tx.entity_id).toBeNull();
    expect(await count("payment_events", "reference = ? AND event = 'fulfilled'", [intent.reference])).toBe(0);

    // …and the customer can retry with sane details.
    const retry = await book(ada, intent.reference);
    expect(retry.status).toBe(201);
    expect(await count("bookings")).toBe(1);
  });
});

describe("webhook", () => {
  it("is idempotent under 8 parallel replays of the same event", async () => {
    const intent = await initBooking(ada);
    const event = { event: "charge.success", data: { reference: intent.reference, amount: 500000, currency: "NGN", id: 1, channel: "card" } };

    const results = await Promise.all(Array.from({ length: 8 }, () => signed(event)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.outcome === "marked_success")).toHaveLength(1);
    expect(await count("payment_events", "reference = ? AND event = 'status_changed'", [intent.reference])).toBe(1);
  });

  it("racing the customer's own verification: one status change, one booking", async () => {
    const intent = await initBooking(ada);
    paystackSays(500000);
    const event = { event: "charge.success", data: { reference: intent.reference, amount: 500000, currency: "NGN" } };

    const [hook, booking1, booking2] = await Promise.all([signed(event), book(ada, intent.reference), book(ada, intent.reference)]);

    expect(hook.status).toBe(200);
    expect([booking1.status, booking2.status].sort()).toEqual([200, 201]);
    expect(await count("bookings")).toBe(1);
    expect(await count("payment_events", "reference = ? AND event = 'status_changed'", [intent.reference])).toBe(1);
  });

  it("webhook success then customer submits: booking uses the already-confirmed payment without re-asking Paystack", async () => {
    const intent = await initBooking(ada);
    await signed({ event: "charge.success", data: { reference: intent.reference, amount: 500000, currency: "NGN" } });

    const res = await book(ada, intent.reference);
    expect(res.status).toBe(201);
    expect(verifyTransaction).not.toHaveBeenCalled();
  });

  it("rejects a forged signature and changes nothing", async () => {
    const intent = await initBooking(ada);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("x-paystack-signature", "0".repeat(128))
      .send({ event: "charge.success", data: { reference: intent.reference, amount: 500000, currency: "NGN" } });
    expect(res.status).toBe(401);
    const [[tx]] = await db.query("SELECT status FROM payment_transactions WHERE reference = ?", [intent.reference]);
    expect(tx.status).toBe("pending");
  });
});

describe("shipment payment", () => {
  it("6 simultaneous pickup submissions → one shipment with one timeline entry", async () => {
    const init = await request(app)
      .post("/api/payments/initialize")
      .set("Authorization", auth(ada))
      .send({ purpose: "shipment", zone: "garki", pickup_date: DATE, pickup_time: "10:00" });
    expect(init.status).toBe(201);
    expect(init.body.amount).toBe(2000);
    paystackSays(200000);

    const submit = () =>
      request(app)
        .post("/api/shipments")
        .set("Authorization", auth(ada))
        .send({
          name: "Ada L",
          phone: "0803",
          device: "Laptop",
          brand: "HP",
          fault: "No power",
          address: "1 Test St",
          zone: "garki",
          pickup_date: DATE,
          pickup_time: "10:00",
          payment_reference: init.body.reference,
        });

    const results = await Promise.all(Array.from({ length: 6 }, submit));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(await count("shipments")).toBe(1);
    expect(await count("shipment_events")).toBe(1);
    const [[shipment]] = await db.query("SELECT reference, fee_amount, user_id FROM shipments");
    expect(shipment).toMatchObject({ reference: `FXR-${1000 + results.find((r) => r.status === 201).body.id}`, user_id: ada.id });
    expect(Number(shipment.fee_amount)).toBe(2000);
  });
});
