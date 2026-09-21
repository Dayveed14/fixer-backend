const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");

beforeEach(() => {
  db.__reset();
});

describe("POST /api/tickets (staff-only)", () => {
  it("401s with no token", async () => {
    const res = await request(app).post("/api/tickets").send({});
    expect(res.status).toBe(401);
  });

  it("403s for a customer", async () => {
    const res = await request(app)
      .post("/api/tickets")
      .set("Authorization", authHeader({ role: "user" }))
      .send({ customer_name: "Ada", issue: "Cracked screen" });
    expect(res.status).toBe(403);
  });

  it("creates a ticket for an admin", async () => {
    db.query
      .mockResolvedValueOnce([{ insertId: 5 }])
      .mockResolvedValueOnce([{}]);

    const res = await request(app)
      .post("/api/tickets")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ customer_name: "Ada", issue: "Cracked screen" });

    expect(res.status).toBe(201);
    expect(res.body.ticket_code).toBe("#TK1005");
  });

  it("400s without customer_name/issue", async () => {
    const res = await request(app)
      .post("/api/tickets")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tickets", () => {
  it("401s with no token", async () => {
    const res = await request(app).get("/api/tickets");
    expect(res.status).toBe(401);
  });

  it("forces a customer to their own customer_id", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get("/api/tickets?customer_id=999")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(200);
    const [, params] = db.query.mock.calls[0];
    expect(params).toContain(3);
    expect(params).not.toContain(999);
  });

  it("forces a technician to their own technician_id", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get("/api/tickets?technician_id=999")
      .set("Authorization", authHeader({ id: 7, role: "technician" }));

    expect(res.status).toBe(200);
    const [, params] = db.query.mock.calls[0];
    expect(params).toContain(7);
    expect(params).not.toContain(999);
  });
});

describe("GET /api/tickets/:id", () => {
  it("403s a customer viewing someone else's ticket", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, customer_id: 999, technician_id: null }]]);

    const res = await request(app)
      .get("/api/tickets/1")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(403);
  });

  it("200s for the owning customer", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, customer_id: 3, technician_id: null }]]);

    const res = await request(app)
      .get("/api/tickets/1")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(200);
  });
});

describe("GET /api/tickets/active/:technicianId", () => {
  it("403s a technician requesting someone else's active ticket", async () => {
    const res = await request(app)
      .get("/api/tickets/active/999")
      .set("Authorization", authHeader({ id: 7, role: "technician" }));

    expect(res.status).toBe(403);
  });

  it("200s (with null) when there's no active ticket", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get("/api/tickets/active/7")
      .set("Authorization", authHeader({ id: 7, role: "technician" }));

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("lets an admin look up any technician's active ticket", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, ticket_code: "#TK1001" }]]);

    const res = await request(app)
      .get("/api/tickets/active/7")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
    expect(res.body.ticket_code).toBe("#TK1001");
  });
});

describe("PATCH /api/tickets/:id/status", () => {
  it("403s for a customer (staff-only endpoint)", async () => {
    const res = await request(app)
      .patch("/api/tickets/1/status")
      .set("Authorization", authHeader({ role: "user" }))
      .send({ status: "Completed" });
    expect(res.status).toBe(403);
  });

  it("400s an invalid status", async () => {
    const res = await request(app)
      .patch("/api/tickets/1/status")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ status: "Whatever" });
    expect(res.status).toBe(400);
  });

  it("blocks a technician updating a ticket that isn't theirs", async () => {
    db.query.mockResolvedValueOnce([[{ technician_id: 999 }]]);

    const res = await request(app)
      .patch("/api/tickets/1/status")
      .set("Authorization", authHeader({ id: 7, role: "technician" }))
      .send({ status: "Completed" });

    expect(res.status).toBe(403);
  });

  it("lets an assigned technician update status", async () => {
    db.query
      .mockResolvedValueOnce([[{ technician_id: 7 }]])
      .mockResolvedValueOnce([{}]);

    const res = await request(app)
      .patch("/api/tickets/1/status")
      .set("Authorization", authHeader({ id: 7, role: "technician" }))
      .send({ status: "Completed", amount: 5000 });

    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/tickets/:id/assign (admin-only)", () => {
  it("403s for a technician", async () => {
    const res = await request(app)
      .patch("/api/tickets/1/assign")
      .set("Authorization", authHeader({ role: "technician" }))
      .send({ technician_id: 7 });
    expect(res.status).toBe(403);
  });

  it("200s for an admin", async () => {
    db.query.mockResolvedValueOnce([{}]);

    const res = await request(app)
      .patch("/api/tickets/1/assign")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ technician_id: 7 });

    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/tickets/:id (admin full edit)", () => {
  it("403s for a technician", async () => {
    const res = await request(app)
      .patch("/api/tickets/1")
      .set("Authorization", authHeader({ role: "technician" }))
      .send({ customer_name: "Ada", issue: "New issue" });
    expect(res.status).toBe(403);
  });

  it("400s an invalid priority", async () => {
    const res = await request(app)
      .patch("/api/tickets/1")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ customer_name: "Ada", issue: "x", priority: "Extreme" });
    expect(res.status).toBe(400);
  });

  it("404s when the ticket doesn't exist", async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

    const res = await request(app)
      .patch("/api/tickets/999")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ customer_name: "Ada", issue: "x" });

    expect(res.status).toBe(404);
  });

  it("200s a valid admin edit", async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .patch("/api/tickets/1")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ customer_name: "Ada", issue: "x", priority: "High" });

    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/tickets/:id (admin-only)", () => {
  it("403s for a technician", async () => {
    const res = await request(app)
      .delete("/api/tickets/1")
      .set("Authorization", authHeader({ role: "technician" }));
    expect(res.status).toBe(403);
  });

  it("200s for an admin", async () => {
    db.query.mockResolvedValueOnce([{}]);

    const res = await request(app)
      .delete("/api/tickets/1")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
  });
});
