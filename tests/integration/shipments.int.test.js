// P0: shipment lifecycle on a real database — concurrent status changes
// and concurrent approve/decline can't both win.
jest.mock("../../services/paystackService");
jest.mock("../../services/mailService");
jest.mock("../../services/meshCentralService");
jest.mock("../../services/gemini");

const request = require("supertest");
const app = require("../../app");
const { verifyTransaction } = require("../../services/paystackService");
const { db, resetData, createUser, auth, count } = require("./helpers");
const { tomorrow } = require("../helpers/dates");

let ada;
let admin;
let tech;

async function insertShipment(fields = {}) {
  const row = {
    reference: "PENDING",
    user_id: ada.id,
    name: "Ada L",
    email: ada.email,
    phone: "0803",
    device: "Laptop",
    brand: "HP",
    fault: "No power",
    address: "1 Test St",
    city: "Garki, Abuja",
    pickup_zone: "garki",
    pickup_date: tomorrow(),
    pickup_time: "10:00:00",
    fee_amount: 2000,
    payment_status: "paid",
    payment_reference: `FXS_TEST_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    status: "pickup_scheduled",
    ...fields,
  };
  const cols = Object.keys(row);
  const [result] = await db.query(
    `INSERT INTO shipments (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    Object.values(row),
  );
  await db.query("UPDATE shipments SET reference = ? WHERE id = ?", [`FXR-${1000 + result.insertId}`, result.insertId]);
  return result.insertId;
}

const setStatus = (id, status, extra = {}) =>
  request(app).patch(`/api/shipments/${id}/status`).set("Authorization", auth(admin)).send({ status, ...extra });

beforeEach(async () => {
  await resetData();
  verifyTransaction.mockReset();
  ada = await createUser();
  admin = await createUser({ role: "admin" });
  tech = await createUser({ role: "technician" });
});

afterAll(async () => {
  await db.query("DELETE FROM pricing_settings WHERE setting_key = 'charge_return_on_decline'");
  await db.end();
});

it("five admins clicking the same step at once: it happens exactly once", async () => {
  const id = await insertShipment();

  const results = await Promise.all(Array.from({ length: 5 }, () => setStatus(id, "courier_assigned")));

  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  expect(await count("shipment_events", "shipment_id = ?", [id])).toBe(1);
  const [[row]] = await db.query("SELECT status FROM shipments WHERE id = ?", [id]);
  expect(row.status).toBe("courier_assigned");
});

it("walks the whole lifecycle with valid SQL at every step", async () => {
  const id = await insertShipment();
  for (const status of ["courier_assigned", "device_collected", "diagnosis"]) {
    expect((await setStatus(id, status)).status).toBe(200);
  }

  const quote = await request(app)
    .post(`/api/shipments/${id}/quote`)
    .set("Authorization", auth(admin))
    .send({ diagnosis: "Dead charging IC", repair_cost: 25000 });
  expect(quote.status).toBe(200);

  const init = await request(app)
    .post("/api/payments/initialize")
    .set("Authorization", auth(ada))
    .send({ purpose: "repair", shipment_id: id });
  expect(init.status).toBe(201);
  verifyTransaction.mockResolvedValue({ status: "success", currency: "NGN", amount: init.body.amount * 100 });

  const approve = await request(app)
    .post(`/api/shipments/${id}/approval`)
    .set("Authorization", auth(ada))
    .send({ decision: "approve", payment_reference: init.body.reference });
  expect(approve.status).toBe(200);

  expect((await setStatus(id, "repair", { technician_id: tech.id })).status).toBe(200);

  const assigned = await request(app).get("/api/shipments/assigned").set("Authorization", auth(tech));
  expect(assigned.status).toBe(200);
  expect(assigned.body.map((s) => s.id)).toContain(id);

  const report = await request(app)
    .post(`/api/shipments/${id}/repair-result`)
    .set("Authorization", auth(tech))
    .send({ outcome: "repaired", note: "Replaced IC" });
  expect(report.status).toBe(200);

  expect((await setStatus(id, "quality_check")).status).toBe(200);
  expect((await setStatus(id, "ready_for_delivery")).status).toBe(200);

  const confirm = await request(app).post(`/api/shipments/${id}/confirm-delivery`).set("Authorization", auth(ada));
  expect(confirm.status).toBe(200);

  const [[final]] = await db.query("SELECT status, approval_status, repair_outcome, delivered_at FROM shipments WHERE id = ?", [id]);
  expect(final).toMatchObject({ status: "delivered", approval_status: "approved", repair_outcome: "repaired" });
  expect(final.delivered_at).not.toBeNull();

  const timeline = await request(app).get(`/api/shipments/${id}`).set("Authorization", auth(ada));
  expect(timeline.status).toBe(200);
  expect(timeline.body.events.length).toBeGreaterThanOrEqual(9);
  expect(await count("notifications")).toBeGreaterThan(0);
});

it("approve (paid) racing decline: one answer only; a paid-but-refused approval is flagged", async () => {
  await db.query("REPLACE INTO pricing_settings (setting_key, setting_value) VALUES ('charge_return_on_decline', 'false')");
  require("../../services/pricingService").resetPricingCache();

  const id = await insertShipment({
    status: "waiting_approval",
    approval_status: "pending",
    diagnosis_summary: "Screen",
    repair_cost: 25000,
    return_fee: 2000,
    quote_total: 27000,
  });

  const init = await request(app).post("/api/payments/initialize").set("Authorization", auth(ada)).send({ purpose: "repair", shipment_id: id });
  verifyTransaction.mockResolvedValue({ status: "success", currency: "NGN", amount: 2700000 });

  const [approve, decline] = await Promise.all([
    request(app).post(`/api/shipments/${id}/approval`).set("Authorization", auth(ada)).send({ decision: "approve", payment_reference: init.body.reference }),
    request(app).post(`/api/shipments/${id}/approval`).set("Authorization", auth(ada)).send({ decision: "decline" }),
  ]);

  const statuses = [approve.status, decline.status];
  expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  expect(statuses.filter((s) => s === 409)).toHaveLength(1);
  expect(await count("shipment_events", "shipment_id = ?", [id])).toBe(1);

  const [[shipment]] = await db.query("SELECT approval_status FROM shipments WHERE id = ?", [id]);
  const [[payment]] = await db.query("SELECT status, entity_id FROM payment_transactions WHERE reference = ?", [init.body.reference]);
  if (shipment.approval_status === "declined") {
    // The customer paid but the decline won — the payment is left
    // success-but-unused, which the payment-health check alerts on.
    expect(payment).toMatchObject({ status: "success", entity_id: null });
  } else {
    expect(shipment.approval_status).toBe("approved");
    expect(payment.entity_id).toBe(id);
  }
});

it("auto-confirm and the customer confirming at the same moment record one delivery", async () => {
  const id = await insertShipment({ status: "ready_for_delivery" });
  await db.query("UPDATE shipments SET delivery_confirm_by = NOW() - INTERVAL 1 MINUTE WHERE id = ?", [id]);
  const { autoConfirmDueDeliveries } = require("../../services/shipmentLifecycle");

  const [, customer] = await Promise.all([
    autoConfirmDueDeliveries(),
    request(app).post(`/api/shipments/${id}/confirm-delivery`).set("Authorization", auth(ada)),
  ]);

  expect([200, 409]).toContain(customer.status);
  expect(await count("shipment_events", "shipment_id = ? AND status = 'delivered'", [id])).toBe(1);
});
