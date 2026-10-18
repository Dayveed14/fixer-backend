// Shipment lifecycle: status steps, quote, approval/decline with
// payment, delivery confirmation, notifications and the email policy.
const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");
const { routeQueries, callsMatching } = require("../helpers/sqlRouter");
const { verifyTransaction } = require("../../services/paystackService");
const createNotification = require("../../services/notificationService");
const sendMail = require("../../services/mailService");
const pricing = require("../../services/pricingService");
const { autoConfirmDueDeliveries } = require("../../services/shipmentLifecycle");

const ADMIN = authHeader({ id: 1, email: "admin@fixer.ng", role: "admin" });
const TECH = authHeader({ id: 5, email: "tech@fixer.ng", role: "technician" });
const ADA = authHeader({ id: 3, email: "ada@example.com", role: "user" });
const EVE = authHeader({ id: 4, email: "eve@example.com", role: "user" });

const shipment = (overrides = {}) => ({
  id: 3,
  reference: "FXR-1003",
  user_id: 3,
  name: "Ada Lovelace",
  email: "ada@example.com",
  device: "Laptop",
  brand: "HP",
  pickup_zone: "kubwa",
  fee_amount: 4500,
  status: "pickup_scheduled",
  approval_status: null,
  ...overrides,
});

function given(row, extraRoutes = []) {
  routeQueries(db.query, [
    ...extraRoutes,
    [/SELECT \* FROM shipments WHERE id = \? OR reference = \?/, [row ? [row] : []]],
    [/SELECT \* FROM shipments WHERE id = \?$/, [row ? [row] : []]],
    [/UPDATE shipments/, [{ affectedRows: 1 }]],
  ]);
}

const setStatus = (status, auth = ADMIN) =>
  request(app).patch("/api/shipments/3/status").set("Authorization", auth).send({ status });

const adminEmails = () => sendMail.mock.calls.filter(([, sender]) => sender === "admin");
const customerEmails = () => sendMail.mock.calls.filter(([msg]) => msg.to === "ada@example.com");

beforeEach(() => {
  db.__reset();
  createNotification.mockClear();
  sendMail.mockClear();
  verifyTransaction.mockReset();
  process.env.ADMIN_EMAIL = "admin@fixer.ng";
  pricing.__settings.charge_return_on_decline = true;
  pricing.__settings.delivery_confirm_hours = 12;
});

describe("moving through the lifecycle", () => {
  it.each([
    ["pickup_scheduled", "courier_assigned"],
    ["courier_assigned", "device_collected"],
    ["device_collected", "diagnosis"],
    ["repair", "quality_check"],
    ["quality_check", "ready_for_delivery"],
    ["ready_for_delivery", "delivered"],
  ])("%s -> %s is allowed", async (from, to) => {
    given(shipment({ status: from }));
    const res = await setStatus(to);
    expect(res.status).toBe(200);
    const [update] = callsMatching(db.query, /UPDATE shipments SET status = \?/);
    expect(update[1][0]).toBe(to);
    expect(update[1].slice(-2)).toEqual([3, from]); // compare-and-set on the old status
  });

  it.each([
    ["pickup_scheduled", "diagnosis"],
    ["courier_assigned", "repair"],
    ["delivered", "repair"],
    ["cancelled", "courier_assigned"],
    ["repair", "delivered"],
  ])("refuses skipping %s -> %s", async (from, to) => {
    given(shipment({ status: from }));
    const res = await setStatus(to);
    expect(res.status).toBe(409);
    expect(callsMatching(db.query, /UPDATE shipments/)).toHaveLength(0);
  });

  it("never sets waiting_approval directly — the quote form does that", async () => {
    given(shipment({ status: "diagnosis" }));
    const res = await setStatus("waiting_approval");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/quote/);
  });

  it("asks for the quote when moving on from diagnosis", async () => {
    given(shipment({ status: "diagnosis" }));
    const res = await setStatus("repair");
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/diagnosis and repair quote/);
  });

  it("can't start repair until the customer approves and pays", async () => {
    given(shipment({ status: "waiting_approval", approval_status: "pending" }));
    const res = await setStatus("repair");
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Waiting for the customer/);
  });

  it("starts repair after approval", async () => {
    given(shipment({ status: "waiting_approval", approval_status: "approved" }));
    expect((await setStatus("repair")).status).toBe(200);
  });

  it("after a decline, goes straight to ready for delivery (no repair)", async () => {
    given(shipment({ status: "waiting_approval", approval_status: "declined" }));
    expect((await setStatus("repair")).status).toBe(409);
    given(shipment({ status: "waiting_approval", approval_status: "declined" }));
    expect((await setStatus("ready_for_delivery")).status).toBe(200);
  });

  it("ready for delivery opens the confirmation window from Pricing settings", async () => {
    pricing.__settings.delivery_confirm_hours = 8;
    given(shipment({ status: "quality_check" }));
    await setStatus("ready_for_delivery");
    const [update] = callsMatching(db.query, /UPDATE shipments SET status = \?/);
    expect(update[0]).toMatch(/delivery_confirm_by = DATE_ADD\(NOW\(\), INTERVAL \? HOUR\)/);
    expect(update[1]).toEqual(["ready_for_delivery", 8, 3, "quality_check"]);
  });

  it("409s if someone else changed the status first", async () => {
    given(shipment({ status: "pickup_scheduled" }), [[/UPDATE shipments SET status/, [{ affectedRows: 0 }]]]);
    expect((await setStatus("courier_assigned")).status).toBe(409);
  });

  it("customers can't move statuses", async () => {
    expect((await setStatus("courier_assigned", ADA)).status).toBe(403);
  });

  it("technicians can", async () => {
    given(shipment());
    expect((await setStatus("courier_assigned", TECH)).status).toBe(200);
  });
});

describe("timeline + notifications for every step", () => {
  it("records an event and notifies the customer and admins", async () => {
    given(shipment({ status: "pickup_scheduled" }));
    await request(app)
      .patch("/api/shipments/3/status")
      .set("Authorization", ADMIN)
      .send({ status: "courier_assigned", note: "Rider: Musa, 0803..." });

    const [event] = callsMatching(db.query, /INSERT INTO shipment_events/);
    expect(event[1]).toEqual([3, "courier_assigned", "Rider: Musa, 0803...", "admin", 1]);

    const calls = createNotification.mock.calls.map(([n]) => n);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: 3, role: "customer", type: "shipment", reference_type: "shipment", reference_id: 3 }),
        expect.objectContaining({ role: "admin", type: "shipment", reference_type: "shipment" }),
      ]),
    );
  });

  it("returns the timeline with a shipment", async () => {
    given(shipment({ status: "courier_assigned" }), [
      [/FROM shipment_events/, [[{ id: 1, shipment_id: 3, status: "pickup_scheduled" }, { id: 2, shipment_id: 3, status: "courier_assigned" }]]],
    ]);
    const res = await request(app).get("/api/shipments/3").set("Authorization", ADA);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e) => e.status)).toEqual(["pickup_scheduled", "courier_assigned"]);
    expect(res.body.next_actions.statuses).toEqual(["device_collected", "cancelled"]);
  });

  it("attaches each shipment's timeline to the customer's history", async () => {
    routeQueries(db.query, [
      [/WHERE user_id = \? OR email = \?/, [[shipment({ id: 3 }), shipment({ id: 9, reference: "FXR-1009" })]]],
      [/FROM shipment_events/, [[{ shipment_id: 3, status: "pickup_scheduled" }, { shipment_id: 9, status: "delivered" }]]],
    ]);
    const res = await request(app).get("/api/shipments/user/ada@example.com").set("Authorization", ADA);
    expect(res.body[0].events).toHaveLength(1);
    expect(res.body[1].events[0].status).toBe("delivered");
  });
});

describe("diagnosis + quote", () => {
  const quote = (body, auth = ADMIN) =>
    request(app).post("/api/shipments/3/quote").set("Authorization", auth).send(body);

  it("sends the quote with the area's return delivery fee added", async () => {
    given(shipment({ status: "diagnosis" }));

    const res = await quote({ diagnosis: "Faulty charging IC.\nReplace IC.", repair_cost: 25000 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ repair_cost: 25000, return_fee: 4500, quote_total: 29500 }));
    const [update] = callsMatching(db.query, /SET status = 'waiting_approval'/);
    expect(update[1]).toEqual(["Faulty charging IC.\nReplace IC.", 25000, 4500, 29500, 3, "diagnosis"]);

    // Email 2 of 3 to the customer, escaped, with the breakdown
    const [mail] = customerEmails();
    expect(mail[0].subject).toMatch(/quote/i);
    expect(mail[0].html).toContain("₦29,500");
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 3, title: "Waiting for approval" }),
    );
  });

  it.each([
    [{ diagnosis: "", repair_cost: 1000 }],
    [{ diagnosis: "x".repeat(2001), repair_cost: 1000 }],
    [{ diagnosis: "ok", repair_cost: 0 }],
    [{ diagnosis: "ok", repair_cost: 99.5 }],
    [{ diagnosis: "ok", repair_cost: "lots" }],
    [{ diagnosis: "ok", repair_cost: 6000000 }],
  ])("400s %j", async (body) => {
    expect((await quote(body)).status).toBe(400);
  });

  it("needs the shipment to be in diagnosis", async () => {
    given(shipment({ status: "device_collected" }));
    expect((await quote({ diagnosis: "x", repair_cost: 100 })).status).toBe(409);
  });

  it("can be revised while the customer hasn't answered", async () => {
    given(shipment({ status: "waiting_approval", approval_status: "pending" }));
    expect((await quote({ diagnosis: "Revised", repair_cost: 20000 })).status).toBe(200);
  });

  it("can't be changed after the customer answered", async () => {
    given(shipment({ status: "waiting_approval", approval_status: "approved" }));
    expect((await quote({ diagnosis: "x", repair_cost: 100 })).status).toBe(409);
  });

  it("customers can't send quotes", async () => {
    expect((await quote({ diagnosis: "x", repair_cost: 100 }, ADA)).status).toBe(403);
  });
});

describe("paying for the repair (payment initialisation)", () => {
  const init = (body, auth = ADA) =>
    request(app).post("/api/payments/initialize").set("Authorization", auth).send(body);

  const quoted = () =>
    shipment({ status: "waiting_approval", approval_status: "pending", repair_cost: "25000.00", return_fee: "4500.00" });

  it("approve: charges repair + return delivery from the stored quote", async () => {
    given(quoted());
    const res = await init({ purpose: "repair", shipment_id: 3, amount: 1 });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(29500);
    expect(res.body.reference).toMatch(/^FXR_/);
    const [insert] = callsMatching(db.query, /INSERT INTO payment_transactions/);
    expect(JSON.parse(insert[1][5])).toEqual({ shipment_id: "3" });
  });

  it("decline: charges only the return delivery", async () => {
    given(quoted());
    const res = await init({ purpose: "return", shipment_id: 3 });
    expect(res.body.amount).toBe(4500);
  });

  it("decline needs no payment if the admin turned that policy off", async () => {
    pricing.__settings.charge_return_on_decline = false;
    given(quoted());
    expect((await init({ purpose: "return", shipment_id: 3 })).status).toBe(400);
  });

  it("403s someone else's shipment", async () => {
    given(quoted());
    expect((await init({ purpose: "repair", shipment_id: 3 }, EVE)).status).toBe(403);
  });

  it("409s when there's no open quote", async () => {
    given(shipment({ status: "repair", approval_status: "approved" }));
    expect((await init({ purpose: "repair", shipment_id: 3 })).status).toBe(409);
  });
});

describe("approving / declining the quote", () => {
  const conn = db.mockConnection;
  const respond = (body, auth = ADA) =>
    request(app).post("/api/shipments/3/approval").set("Authorization", auth).send(body);

  const quoted = (o = {}) =>
    shipment({ status: "waiting_approval", approval_status: "pending", repair_cost: 25000, return_fee: 4500, ...o });

  const payment = (o = {}) => ({
    reference: "FXR_1",
    user_id: 3,
    purpose: "repair",
    amount_kobo: 2950000,
    currency: "NGN",
    status: "pending",
    metadata: { shipment_id: "3" },
    ...o,
  });

  function givenAnswer(row, pay, lockedShipment = { status: "waiting_approval", approval_status: "pending" }) {
    given(row, [[/SELECT \* FROM payment_transactions/, [pay ? [pay] : []]]]);
    routeQueries(conn.query, [
      [/FROM payment_transactions[\s\S]*FOR UPDATE/, [[{ status: "success", entity_id: null }]]],
      [/FROM shipments WHERE id = \? FOR UPDATE/, [[lockedShipment]]],
    ]);
  }

  it("approve: verifies payment, records approval in one transaction, tells the admin", async () => {
    givenAnswer(quoted(), payment());
    verifyTransaction.mockResolvedValueOnce({ status: "success", currency: "NGN", amount: 2950000 });

    const res = await respond({ decision: "approve", payment_reference: "FXR_1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ approval_status: "approved", amount_paid: 29500 }));
    const [update] = callsMatching(conn.query, /SET approval_status = \?/);
    expect(update[1]).toEqual(["approved", "FXR_1", 29500, 3]);
    expect(callsMatching(conn.query, /INSERT INTO shipment_events/)).toHaveLength(1);
    expect(callsMatching(conn.query, /SET entity_type = \?, entity_id = \?/)[0][1].slice(0, 2)).toEqual(["shipment_repair", 3]);
    expect(conn.commit).toHaveBeenCalled();

    expect(adminEmails()).toHaveLength(1);
    expect(adminEmails()[0][0].subject).toMatch(/Repair approved/);
    expect(customerEmails()).toHaveLength(0); // not one of the 3 customer emails
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ role: "admin", title: "FXR-1003: repair approved" }),
    );
  });

  it("decline: pays the return fee and tells the admin", async () => {
    givenAnswer(quoted(), payment({ reference: "FXT_1", purpose: "return", amount_kobo: 450000 }));
    verifyTransaction.mockResolvedValueOnce({ status: "success", currency: "NGN", amount: 450000 });

    const res = await respond({ decision: "decline", payment_reference: "FXT_1" });

    expect(res.status).toBe(200);
    expect(res.body.approval_status).toBe("declined");
    expect(adminEmails()[0][0].subject).toMatch(/Repair declined/);
  });

  it("decline without payment when the policy is off", async () => {
    pricing.__settings.charge_return_on_decline = false;
    given(quoted());
    routeQueries(conn.query, [[/FOR UPDATE/, [[{ status: "waiting_approval", approval_status: "pending" }]]]]);
    const res = await respond({ decision: "decline" });
    expect(res.status).toBe(200);
    expect(verifyTransaction).not.toHaveBeenCalled();
    expect(callsMatching(conn.query, /SET approval_status = \?/)[0][1]).toEqual(["declined", null, 0, 3]);
  });

  it("refuses a decline (return) payment used to approve", async () => {
    givenAnswer(quoted(), payment({ purpose: "return" }));
    const res = await respond({ decision: "approve", payment_reference: "FXR_1" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WRONG_PURPOSE");
  });

  it("refuses a payment made for a different shipment", async () => {
    givenAnswer(quoted(), payment({ metadata: { shipment_id: "99" } }));
    expect((await respond({ decision: "approve", payment_reference: "FXR_1" })).status).toBe(409);
  });

  it("403s another customer", async () => {
    given(quoted());
    expect((await respond({ decision: "approve", payment_reference: "FXR_1" }, EVE)).status).toBe(403);
  });

  it("needs a payment to approve", async () => {
    given(quoted());
    expect((await respond({ decision: "approve" })).status).toBe(400);
  });

  it("a retry with the same payment returns success without repeating anything", async () => {
    givenAnswer(quoted({ approval_status: "approved", approval_payment_reference: "FXR_1" }), payment({ status: "success" }));
    const res = await respond({ decision: "approve", payment_reference: "FXR_1" });
    expect(res.status).toBe(200);
    expect(conn.beginTransaction).not.toHaveBeenCalled();
    expect(adminEmails()).toHaveLength(0);
  });

  it("rolls back if the quote was answered in the meantime", async () => {
    givenAnswer(quoted(), payment({ status: "success" }), { status: "waiting_approval", approval_status: "declined" });
    const res = await respond({ decision: "approve", payment_reference: "FXR_1" });
    expect(res.status).toBe(409);
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });
});

describe("delivery confirmation", () => {
  const confirm = (auth = ADA) =>
    request(app).post("/api/shipments/3/confirm-delivery").set("Authorization", auth);

  it("the customer confirms receipt; admins are notified (no email)", async () => {
    given(shipment({ status: "ready_for_delivery" }));
    const res = await confirm();
    expect(res.status).toBe(200);
    const [update] = callsMatching(db.query, /SET status = 'delivered'/);
    expect(update[0]).toMatch(/delivery_confirmed_by = 'customer'/);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ role: "admin", title: "FXR-1003: delivered" }),
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("is idempotent once delivered", async () => {
    given(shipment({ status: "delivered" }));
    expect((await confirm()).status).toBe(200);
    expect(callsMatching(db.query, /UPDATE shipments/)).toHaveLength(0);
  });

  it("409s before the device is out for delivery", async () => {
    given(shipment({ status: "repair" }));
    expect((await confirm()).status).toBe(409);
  });

  it("403s another customer", async () => {
    given(shipment({ status: "ready_for_delivery" }));
    expect((await confirm(EVE)).status).toBe(403);
  });
});

describe("automatic delivery confirmation", () => {
  it("marks overdue deliveries delivered, notifies and emails the admin", async () => {
    routeQueries(db.query, [
      [/delivery_confirm_by <= NOW\(\)/, [[shipment({ id: 3, status: "ready_for_delivery" }), shipment({ id: 4, reference: "FXR-1004", status: "ready_for_delivery" })]]],
      [/WHERE id = \? AND status = 'ready_for_delivery'/, (sql, params) => [{ affectedRows: params[0] === 3 ? 1 : 0 }]],
    ]);

    const count = await autoConfirmDueDeliveries();

    expect(count).toBe(1); // #4 was confirmed by the customer in the meantime
    const [event] = callsMatching(db.query, /INSERT INTO shipment_events/);
    expect(event[1]).toEqual(expect.arrayContaining([3, "delivered", "system"]));
    expect(adminEmails()).toHaveLength(1);
    expect(adminEmails()[0][0].subject).toMatch(/auto-confirmed/);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ user_id: 3, title: "Delivered" }));
  });

  it("does nothing before the migration adds the columns", async () => {
    db.query.mockRejectedValueOnce(Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR" }));
    await expect(autoConfirmDueDeliveries()).resolves.toBe(0);
  });
});

describe("email policy", () => {
  it.each(["courier_assigned", "device_collected", "diagnosis", "repair", "quality_check"])(
    "sends no email for %s",
    async (to) => {
      const from = { courier_assigned: "pickup_scheduled", device_collected: "courier_assigned", diagnosis: "device_collected", repair: "waiting_approval", quality_check: "repair" }[to];
      given(shipment({ status: from, approval_status: from === "waiting_approval" ? "approved" : null }));
      await setStatus(to);
      expect(sendMail).not.toHaveBeenCalled();
    },
  );

  it("emails the customer (only) when ready for delivery", async () => {
    given(shipment({ status: "quality_check" }));
    await setStatus("ready_for_delivery");
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(customerEmails()[0][0].html).toMatch(/12 hours/);
  });

  it("sends no email when an admin marks it delivered", async () => {
    given(shipment({ status: "ready_for_delivery" }));
    await setStatus("delivered");
    expect(sendMail).not.toHaveBeenCalled();
  });
});
