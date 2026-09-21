const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");

beforeEach(() => {
  db.__reset();
});

describe("POST /api/devices", () => {
  it("401s with no token", async () => {
    const res = await request(app).post("/api/devices").send({ device_name: "iPhone" });
    expect(res.status).toBe(401);
  });

  it("400s without device_name", async () => {
    const res = await request(app)
      .post("/api/devices")
      .set("Authorization", authHeader({ role: "user" }))
      .send({});
    expect(res.status).toBe(400);
  });

  it("registers a device under the caller's own id, ignoring any spoofed customer_id", async () => {
    db.query.mockResolvedValueOnce([{ insertId: 10 }]);

    const res = await request(app)
      .post("/api/devices")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ device_name: "iPhone 13", customer_id: 999 });

    expect(res.status).toBe(201);
    const [, params] = db.query.mock.calls[0];
    expect(params[0]).toBe(3);
  });
});

describe("GET /api/devices", () => {
  it("401s with no token", async () => {
    const res = await request(app).get("/api/devices");
    expect(res.status).toBe(401);
  });

  it("forces a customer's query to their own id regardless of query string", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get("/api/devices?customer_id=999")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE customer_id = \?/);
    expect(params).toEqual([3]);
  });

  it("lets an admin filter by any customer_id, or see all with none", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get("/api/devices")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
    const [sql] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/WHERE/);
  });
});

describe("PATCH /api/devices/:id/service", () => {
  it("blocks a customer updating someone else's device", async () => {
    db.query.mockResolvedValueOnce([[{ customer_id: 999 }]]);

    const res = await request(app)
      .patch("/api/devices/1/service")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ last_serviced_at: "2026-01-01" });

    expect(res.status).toBe(403);
  });

  it("lets the owning customer update their device", async () => {
    db.query
      .mockResolvedValueOnce([[{ customer_id: 3 }]])
      .mockResolvedValueOnce([{}]);

    const res = await request(app)
      .patch("/api/devices/1/service")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ last_serviced_at: "2026-01-01" });

    expect(res.status).toBe(200);
  });

  it("lets a technician update any device without an ownership check", async () => {
    db.query.mockResolvedValueOnce([{}]);

    const res = await request(app)
      .patch("/api/devices/1/service")
      .set("Authorization", authHeader({ role: "technician" }))
      .send({ last_serviced_at: "2026-01-01" });

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(1); // no ownership lookup for staff
  });
});

describe("DELETE /api/devices/:id", () => {
  it("blocks a customer deleting someone else's device", async () => {
    db.query.mockResolvedValueOnce([[{ customer_id: 999 }]]);

    const res = await request(app)
      .delete("/api/devices/1")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(403);
  });

  it("lets the owning customer delete their device", async () => {
    db.query
      .mockResolvedValueOnce([[{ customer_id: 3 }]])
      .mockResolvedValueOnce([{}]);

    const res = await request(app)
      .delete("/api/devices/1")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(200);
  });
});
