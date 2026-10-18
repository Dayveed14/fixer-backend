// Repair assignment (admin) and the technician's "repaired" report.
const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");
const { routeQueries, callsMatching } = require("../helpers/sqlRouter");
const createNotification = require("../../services/notificationService");
const sendMail = require("../../services/mailService");

const ADMIN = authHeader({ id: 1, role: "admin" });
const TECH = authHeader({ id: 5, email: "tee@fixer.ng", role: "technician" });
const OTHER_TECH = authHeader({ id: 6, role: "technician" });

const shipment = (o = {}) => ({
  id: 3,
  reference: "FXR-1003",
  user_id: 3,
  name: "Ada",
  email: "ada@example.com",
  device: "Laptop",
  brand: "HP",
  fault: "Won't charge",
  diagnosis_summary: "Charging IC damaged",
  status: "waiting_approval",
  approval_status: "approved",
  technician_id: null,
  repair_outcome: null,
  ...o,
});

function given(row, techRow = { id: 5, first_name: "Tee", last_name: "Tech", email: "tee@fixer.ng" }) {
  routeQueries(db.query, [
    [/FROM users WHERE id = \? AND role = 'technician'/, [techRow ? [techRow] : []]],
    [/SELECT \* FROM shipments WHERE id = \? OR reference = \?/, [row ? [row] : []]],
    [/SELECT \* FROM shipments WHERE technician_id = \?/, [[row]]],
    [/UPDATE shipments/, [{ affectedRows: 1 }]],
  ]);
}

beforeEach(() => {
  db.__reset();
  createNotification.mockClear();
  sendMail.mockClear();
});

describe("admin starts the repair by assigning a technician", () => {
  const start = (body) =>
    request(app).patch("/api/shipments/3/status").set("Authorization", ADMIN).send({ status: "repair", ...body });

  it("assigns the technician, records it and notifies them", async () => {
    given(shipment());
    const res = await start({ technician_id: 5 });
    expect(res.status).toBe(200);

    const [update] = callsMatching(db.query, /UPDATE shipments SET status = \?/);
    expect(update[0]).toMatch(/technician_id = \?, repair_outcome = NULL/);
    expect(update[1]).toEqual(["repair", 5, 3, "waiting_approval"]);

    const [event] = callsMatching(db.query, /INSERT INTO shipment_events/);
    expect(event[1][2]).toMatch(/Assigned to Tee Tech/);

    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 5, role: "technician", title: "New repair assigned", reference_type: "shipment" }),
    );
  });

  it("400s without a technician", async () => {
    given(shipment());
    expect((await start({})).status).toBe(400);
  });

  it("404s a user who isn't a technician", async () => {
    given(shipment(), null);
    expect((await start({ technician_id: 3 })).status).toBe(404);
  });
});

describe("technician reports the repair", () => {
  const report = (body, auth = TECH) =>
    request(app).post("/api/shipments/3/repair-result").set("Authorization", auth).send(body);

  it("marks it repaired with no amount, and tells the admin", async () => {
    given(shipment({ status: "repair", technician_id: 5 }));
    const res = await report({ outcome: "repaired" });
    expect(res.status).toBe(200);
    expect(res.body.next_actions.statuses).toEqual(["quality_check"]);

    const [update] = callsMatching(db.query, /SET repair_outcome = \?/);
    expect(update[1]).toEqual(["repaired", null, 3]);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ role: "admin", title: "FXR-1003: repaired" }),
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("can report it unrepairable, with a reason", async () => {
    given(shipment({ status: "repair", technician_id: 5 }));
    expect((await report({ outcome: "unrepairable" })).status).toBe(400);
    given(shipment({ status: "repair", technician_id: 5 }));
    const res = await report({ outcome: "unrepairable", note: "Board is cracked" });
    expect(res.status).toBe(200);
    expect(res.body.next_actions.statuses).toEqual(["ready_for_delivery"]);
  });

  it("403s a technician it isn't assigned to", async () => {
    given(shipment({ status: "repair", technician_id: 5 }));
    expect((await report({ outcome: "repaired" }, OTHER_TECH)).status).toBe(403);
  });

  it("409s when not in repair or already reported", async () => {
    given(shipment({ status: "quality_check", technician_id: 5 }));
    expect((await report({ outcome: "repaired" })).status).toBe(409);
    given(shipment({ status: "repair", technician_id: 5, repair_outcome: "repaired" }));
    expect((await report({ outcome: "repaired" })).status).toBe(409);
  });

  it("customers can't report repairs", async () => {
    const res = await report({ outcome: "repaired" }, authHeader({ id: 3, role: "user" }));
    expect(res.status).toBe(403);
  });
});

describe("the admin's quality check waits for the technician", () => {
  const toQc = () =>
    request(app).patch("/api/shipments/3/status").set("Authorization", ADMIN).send({ status: "quality_check" });

  it("409s until the technician marks it repaired", async () => {
    given(shipment({ status: "repair", technician_id: 5 }));
    const res = await toQc();
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/technician to mark/);
  });

  it("allows quality check once repaired", async () => {
    given(shipment({ status: "repair", technician_id: 5, repair_outcome: "repaired" }));
    expect((await toQc()).status).toBe(200);
  });

  it("an unrepairable device goes back to the customer instead", async () => {
    given(shipment({ status: "repair", technician_id: 5, repair_outcome: "unrepairable" }));
    expect((await toQc()).status).toBe(409);
  });
});

describe("GET /api/shipments/assigned", () => {
  it("lists the technician's own repairs with their timeline", async () => {
    given(shipment({ status: "repair", technician_id: 5 }));
    const res = await request(app).get("/api/shipments/assigned").set("Authorization", TECH);
    expect(res.status).toBe(200);
    expect(res.body[0].reference).toBe("FXR-1003");
    expect(callsMatching(db.query, /WHERE technician_id = \?/)[0][1]).toEqual([5]);
  });

  it("is closed to customers", async () => {
    const res = await request(app).get("/api/shipments/assigned").set("Authorization", authHeader({ role: "user" }));
    expect(res.status).toBe(403);
  });

  it("lets the assigned technician open the shipment", async () => {
    given(shipment({ status: "repair", technician_id: 5, email: "someone@else.com", user_id: 99 }));
    expect((await request(app).get("/api/shipments/3").set("Authorization", TECH)).status).toBe(200);
    expect((await request(app).get("/api/shipments/3").set("Authorization", OTHER_TECH)).status).toBe(403);
  });
});
