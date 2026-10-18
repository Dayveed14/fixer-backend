// POST /api/bookings — payment verification, idempotency and
// transactional consistency. See services/paymentService.js.
const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");
const { routeQueries, callsMatching } = require("../helpers/sqlRouter");
const { tomorrow } = require("../helpers/dates");
const { verifyTransaction, PaystackUnavailableError } = require("../../services/paystackService");
const createNotification = require("../../services/notificationService");

const conn = db.mockConnection;
const DATE = tomorrow();

const paymentRow = (overrides = {}) => ({
  reference: "FXB_1",
  user_id: 3,
  purpose: "booking",
  amount_kobo: 500000,
  currency: "NGN",
  status: "pending",
  entity_id: null,
  metadata: JSON.stringify({ support_type: "voice", booking_date: DATE, booking_time: "10:00:00" }),
  ...overrides,
});

const body = (overrides = {}) => ({
  support_type: "voice",
  booking_date: DATE,
  booking_time: "10:00",
  payment_reference: "FXB_1",
  issue_summary: "Laptop won't boot",
  ...overrides,
});

const customer = (id = 3) => authHeader({ id, email: "ada@example.com", role: "user" });

function givenPayment(row, { lockedRow, insertResult } = {}) {
  routeQueries(db.query, [
    [/FROM users WHERE id/, [[{ first_name: "Ada", last_name: "L", email: "ada@example.com" }]]],
    [/SELECT \* FROM payment_transactions/, [row ? [row] : []]],
  ]);
  routeQueries(conn.query, [
    [/FOR UPDATE/, [[lockedRow || { ...row, status: "success" }]]],
    [/INSERT INTO bookings/, insertResult || [{ insertId: 55 }]],
  ]);
}

const post = (b = body(), auth = customer()) =>
  request(app).post("/api/bookings").set("Authorization", auth).send(b);

beforeEach(() => {
  db.__reset();
  verifyTransaction.mockReset().mockResolvedValue({
    status: "success",
    currency: "NGN",
    amount: 500000,
    id: 999,
    channel: "card",
  });
  createNotification.mockClear();
});

describe("successful payment verification", () => {
  it("verifies with Paystack, marks the payment success and creates the booking in one transaction", async () => {
    givenPayment(paymentRow());

    const res = await post(body({ user_id: 999 })); // spoofed user_id ignored

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 55, booking_reference: "#BK1055", amount: 5000 });
    expect(verifyTransaction).toHaveBeenCalledWith("FXB_1");

    // pending -> success, compare-and-set on the old status
    const [statusUpdate] = callsMatching(db.query, /UPDATE payment_transactions\s+SET status/);
    expect(statusUpdate[1]).toEqual(expect.arrayContaining(["success", "FXB_1", "pending"]));

    // Booking insert happened on the transaction connection, for the token's user
    const [insert] = callsMatching(conn.query, /INSERT INTO bookings/);
    expect(insert[1][1]).toBe(3);
    expect(insert[1][8]).toBe(5000); // amount comes from the payment row
    expect(callsMatching(db.query, /INSERT INTO bookings/)).toHaveLength(0);

    // Linked + audited inside the same transaction, then committed
    expect(callsMatching(conn.query, /SET entity_type = \?, entity_id = \?/)).toHaveLength(1);
    expect(callsMatching(conn.query, /INSERT INTO payment_events/)).toHaveLength(1);
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  it("skips Paystack if the webhook already confirmed the payment", async () => {
    givenPayment(paymentRow({ status: "success" }));
    const res = await post();
    expect(res.status).toBe(201);
    expect(verifyTransaction).not.toHaveBeenCalled();
  });

  it("still succeeds if notifications fail after commit", async () => {
    givenPayment(paymentRow());
    createNotification.mockRejectedValueOnce(new Error("notify down"));
    const res = await post();
    expect(res.status).toBe(201);
  });
});

describe("incorrect amount or currency", () => {
  it("402s and marks the payment `mismatch` when Paystack reports a different amount", async () => {
    givenPayment(paymentRow());
    verifyTransaction.mockResolvedValueOnce({ status: "success", currency: "NGN", amount: 100 });

    const res = await post();

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("PAYMENT_MISMATCH");
    const [update] = callsMatching(db.query, /UPDATE payment_transactions\s+SET status/);
    expect(update[1][0]).toBe("mismatch");
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  it("402s on the wrong currency", async () => {
    givenPayment(paymentRow());
    verifyTransaction.mockResolvedValueOnce({ status: "success", currency: "USD", amount: 500000 });
    const res = await post();
    expect(res.status).toBe(402);
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  it("checks the amount against the server record, not the client's support_type claim", async () => {
    // Paid for voice (₦5,000) but submits video (₦7,000).
    givenPayment(paymentRow());
    const res = await post(body({ support_type: "video" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DETAILS_CHANGED");
    expect(verifyTransaction).not.toHaveBeenCalled();
  });

  it("refuses a different time slot from the one paid for", async () => {
    givenPayment(paymentRow());
    const res = await post(body({ booking_time: "11:00" }));
    expect(res.status).toBe(409);
  });
});

describe("failed and pending transactions have explicit states", () => {
  it.each([
    ["failed", "PAYMENT_FAILED", 402],
    ["abandoned", "PAYMENT_ABANDONED", 402],
    ["reversed", "PAYMENT_REVERSED", 402],
    ["ongoing", "PAYMENT_PENDING", 409],
  ])("Paystack status %s -> %s", async (paystackStatus, code, httpStatus) => {
    givenPayment(paymentRow());
    verifyTransaction.mockResolvedValueOnce({ status: paystackStatus, currency: "NGN", amount: 500000 });

    const res = await post();

    expect(res.status).toBe(httpStatus);
    expect(res.body.code).toBe(code);
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  it("leaves the payment pending (503) when Paystack is unreachable — safe to retry", async () => {
    givenPayment(paymentRow());
    verifyTransaction.mockRejectedValueOnce(new PaystackUnavailableError("timed out"));

    const res = await post();

    expect(res.status).toBe(503);
    expect(callsMatching(db.query, /UPDATE payment_transactions\s+SET status/)).toHaveLength(0);
    const events = callsMatching(db.query, /INSERT INTO payment_events/);
    expect(events[0][1]).toContain("verify_unavailable");
  });

  it("402s when Paystack has no completed transaction for the reference", async () => {
    givenPayment(paymentRow());
    verifyTransaction.mockRejectedValueOnce(new Error("Transaction reference not found"));
    const res = await post();
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("NOT_PAID");
  });
});

describe("duplicate payment reference / idempotency", () => {
  it("returns the existing booking (200) instead of creating a second one", async () => {
    givenPayment(paymentRow({ status: "success" }), {
      lockedRow: { reference: "FXB_1", status: "success", entity_id: 55 },
    });

    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 55, booking_reference: "#BK1055" });
    expect(callsMatching(conn.query, /INSERT INTO bookings/)).toHaveLength(0);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("two concurrent submissions: the second sees the lock holder's booking", async () => {
    // First request already fulfilled by the time the second takes the lock.
    givenPayment(paymentRow({ status: "success" }), {
      lockedRow: { reference: "FXB_1", status: "success", entity_id: 77 },
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(77);
  });

  it("409s if the DB unique key catches a duplicate reference", async () => {
    givenPayment(paymentRow(), {
      insertResult: () => {
        throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
      },
    });
    const res = await post();
    expect(res.status).toBe(409);
    expect(conn.rollback).toHaveBeenCalled();
  });
});

describe("failed database update", () => {
  it("rolls back the transaction and 500s if the booking insert fails", async () => {
    givenPayment(paymentRow(), {
      insertResult: () => {
        throw new Error("connection lost");
      },
    });

    const res = await post();

    expect(res.status).toBe(500);
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  it("rolls back if linking the payment to the booking fails", async () => {
    givenPayment(paymentRow());
    const routes = conn.query.getMockImplementation();
    conn.query.mockImplementation(async (sql, params) => {
      if (/SET entity_type = \?, entity_id = \?/.test(sql)) throw new Error("lock wait timeout");
      return routes(sql, params);
    });

    const res = await post();
    expect(res.status).toBe(500);
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });
});

describe("customers cannot use another user's payment", () => {
  it("403s and never contacts Paystack", async () => {
    givenPayment(paymentRow({ user_id: 8 }));
    const res = await post(body(), customer(3));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_OWNER");
    expect(verifyTransaction).not.toHaveBeenCalled();
  });

  it("404s an unknown reference", async () => {
    givenPayment(null);
    const res = await post();
    expect(res.status).toBe(404);
  });

  it("400s a shipment payment used for a booking", async () => {
    givenPayment(paymentRow({ purpose: "shipment" }));
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WRONG_PURPOSE");
  });
});

describe("input validation", () => {
  it("400s an oversized issue summary", async () => {
    const res = await post(body({ issue_summary: "x".repeat(2001) }));
    expect(res.status).toBe(400);
  });

  it("400s a malformed time", async () => {
    const res = await post(body({ booking_time: "ten o'clock" }));
    expect(res.status).toBe(400);
  });
});
