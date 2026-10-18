// POST /api/shipments — zone pricing + payment verification.
const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");
const { routeQueries, callsMatching } = require("../helpers/sqlRouter");
const { tomorrow } = require("../helpers/dates");
const { verifyTransaction } = require("../../services/paystackService");
const sendMail = require("../../services/mailService");

const conn = db.mockConnection;
const DATE = tomorrow();

const paymentRow = (overrides = {}) => ({
  reference: "FXS_1",
  user_id: 3,
  purpose: "shipment",
  amount_kobo: 450000, // Kubwa
  currency: "NGN",
  status: "pending",
  entity_id: null,
  metadata: { zone: "kubwa", pickup_date: DATE, pickup_time: "11:00:00" }, // JSON column as object
  ...overrides,
});

const body = (overrides = {}) => ({
  name: "Ada <b>Lovelace</b>",
  phone: "08000000000",
  device: "Laptop",
  brand: "HP",
  fault: "Cracked screen",
  address: "12 Kubwa Road",
  zone: "kubwa",
  pickup_date: DATE,
  pickup_time: "11:00",
  payment_reference: "FXS_1",
  ...overrides,
});

const customer = authHeader({ id: 3, email: "ada@example.com", role: "user" });

function givenPayment(row, lockedRow) {
  routeQueries(db.query, [[/SELECT \* FROM payment_transactions/, [row ? [row] : []]]]);
  routeQueries(conn.query, [
    [/FOR UPDATE/, [[lockedRow || { ...row, status: "success" }]]],
    [/INSERT INTO shipments/, [{ insertId: 3 }]],
  ]);
}

const post = (b = body()) =>
  request(app).post("/api/shipments").set("Authorization", customer).send(b);

beforeEach(() => {
  db.__reset();
  sendMail.mockClear();
  verifyTransaction.mockReset().mockResolvedValue({
    status: "success",
    currency: "NGN",
    amount: 450000,
  });
});

it("creates a Kubwa pickup charged at the Kubwa fee, linked to the account", async () => {
  givenPayment(paymentRow());

  const res = await post();

  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ reference: "FXR-1003", fee_amount: 4500, zone: "kubwa" });

  const [insert] = callsMatching(conn.query, /INSERT INTO shipments/);
  const params = insert[1];
  expect(params[1]).toBe(3); // user_id from token
  expect(params[3]).toBe("ada@example.com"); // defaults to account email
  expect(params[9]).toBe("Kubwa, Abuja"); // city derived from zone
  expect(params[10]).toBe("kubwa"); // pickup_zone
  expect(params[13]).toBe("11:00:00");
  expect(params[14]).toBe(4500);
  expect(conn.commit).toHaveBeenCalled();
});

it("escapes customer-supplied text in notification emails", async () => {
  givenPayment(paymentRow());
  await post();
  const html = sendMail.mock.calls[0][0].html;
  expect(html).toContain("Ada &lt;b&gt;Lovelace&lt;/b&gt;");
  expect(html).not.toContain("<b>Lovelace</b>");
});

it("409s if the customer paid for Garki but submits Kubwa", async () => {
  givenPayment(paymentRow({ amount_kobo: 200000, metadata: { zone: "garki", pickup_date: DATE, pickup_time: "11:00:00" } }));
  const res = await post();
  expect(res.status).toBe(409);
  expect(verifyTransaction).not.toHaveBeenCalled();
});

it("402s when the paid amount doesn't match the zone fee on record", async () => {
  givenPayment(paymentRow());
  verifyTransaction.mockResolvedValueOnce({ status: "success", currency: "NGN", amount: 250000 }); // old flat fee
  const res = await post();
  expect(res.status).toBe(402);
  expect(callsMatching(conn.query, /INSERT INTO shipments/)).toHaveLength(0);
});

it("400s an unknown zone before touching payments", async () => {
  const res = await post(body({ zone: "victoria-island" }));
  expect(res.status).toBe(400);
  expect(db.query).not.toHaveBeenCalled();
});

it("400s oversized fields", async () => {
  const res = await post(body({ address: "x".repeat(301) }));
  expect(res.status).toBe(400);
});

it("returns the existing shipment on a retried submission", async () => {
  givenPayment(paymentRow({ status: "success" }), { status: "success", entity_id: 3 });
  const res = await post();
  expect(res.status).toBe(200);
  expect(res.body.reference).toBe("FXR-1003");
  expect(callsMatching(conn.query, /INSERT INTO shipments/)).toHaveLength(0);
  expect(sendMail).not.toHaveBeenCalled();
});

it("rolls back when the shipment insert fails", async () => {
  givenPayment(paymentRow());
  conn.query.mockImplementation(async (sql) => {
    if (/FOR UPDATE/.test(sql)) return [[{ status: "success", entity_id: null }]];
    if (/INSERT INTO shipments/.test(sql)) throw new Error("disk full");
    return [[]];
  });
  const res = await post();
  expect(res.status).toBe(500);
  expect(conn.rollback).toHaveBeenCalled();
  expect(conn.commit).not.toHaveBeenCalled();
});

describe("shipment status updates", () => {
  it("400s a status outside the agreed vocabulary", async () => {
    const res = await request(app)
      .patch("/api/shipments/1/status")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ status: "lost_in_space" });
    expect(res.status).toBe(400);
  });

  it("404s an unknown shipment", async () => {
    const res = await request(app)
      .patch("/api/shipments/999/status")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ status: "delivered" });
    expect(res.status).toBe(404);
  });
});

describe("shipment ownership", () => {
  it("lets the owner (by account) view a shipment even with a different contact email", async () => {
    db.query.mockResolvedValueOnce([[{ id: 3, user_id: 3, email: "other@example.com" }]]);
    const res = await request(app).get("/api/shipments/3").set("Authorization", customer);
    expect(res.status).toBe(200);
  });

  it("403s another customer looking up the shipment by FXR reference", async () => {
    db.query.mockResolvedValueOnce([[{ id: 3, user_id: 3, email: "ada@example.com" }]]);
    const res = await request(app)
      .get("/api/shipments/FXR-1003")
      .set("Authorization", authHeader({ id: 4, email: "eve@example.com", role: "user" }));
    expect(res.status).toBe(403);
  });

  it("scopes a customer's history to their own account regardless of the :email param", async () => {
    db.query.mockResolvedValueOnce([[{ id: 3 }]]);
    await request(app).get("/api/shipments/user/ada@example.com").set("Authorization", customer);
    expect(db.query.mock.calls[0][1]).toEqual([3, "ada@example.com"]);
  });
});
