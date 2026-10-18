// Who can see payment records and the audit trail.
const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");

beforeEach(() => db.__reset());

const tx = { reference: "FXB_1", user_id: 3, purpose: "booking", status: "success", amount_kobo: 500000, currency: "NGN" };

describe("GET /api/payments/:reference", () => {
  it("401s with no session", async () => {
    expect((await request(app).get("/api/payments/FXB_1")).status).toBe(401);
  });

  it("lets the owner see their payment status", async () => {
    db.query.mockResolvedValueOnce([[tx]]);
    const res = await request(app)
      .get("/api/payments/FXB_1")
      .set("Authorization", authHeader({ id: 3, role: "user" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "success", amount: 5000 });
  });

  it("403s another customer", async () => {
    db.query.mockResolvedValueOnce([[tx]]);
    const res = await request(app)
      .get("/api/payments/FXB_1")
      .set("Authorization", authHeader({ id: 4, role: "user" }));
    expect(res.status).toBe(403);
  });

  it("lets an admin see any payment", async () => {
    db.query.mockResolvedValueOnce([[tx]]);
    const res = await request(app)
      .get("/api/payments/FXB_1")
      .set("Authorization", authHeader({ id: 1, role: "admin" }));
    expect(res.status).toBe(200);
  });

  it("404s an unknown reference", async () => {
    const res = await request(app)
      .get("/api/payments/NOPE")
      .set("Authorization", authHeader({ id: 3, role: "user" }));
    expect(res.status).toBe(404);
  });
});

describe("admin payment views", () => {
  it.each(["user", "technician"])("403s the payment list for a %s", async (role) => {
    const res = await request(app).get("/api/payments").set("Authorization", authHeader({ role }));
    expect(res.status).toBe(403);
  });

  it("lists paid-but-unfulfilled payments for follow-up", async () => {
    const res = await request(app)
      .get("/api/payments?status=success&unfulfilled=true")
      .set("Authorization", authHeader({ role: "admin" }));
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/status = \? AND entity_id IS NULL/);
    expect(params).toEqual(["success"]);
  });

  it("400s an invalid status filter (no SQL built from it)", async () => {
    const res = await request(app)
      .get("/api/payments?status=1%27%20OR%201=1")
      .set("Authorization", authHeader({ role: "admin" }));
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("shows the audit trail to admins only", async () => {
    const asUser = await request(app)
      .get("/api/payments/FXB_1/events")
      .set("Authorization", authHeader({ id: 3, role: "user" }));
    expect(asUser.status).toBe(403);

    db.query.mockResolvedValueOnce([[{ event: "created" }, { event: "status_changed" }]]);
    const asAdmin = await request(app)
      .get("/api/payments/FXB_1/events")
      .set("Authorization", authHeader({ role: "admin" }));
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body).toHaveLength(2);
  });
});
