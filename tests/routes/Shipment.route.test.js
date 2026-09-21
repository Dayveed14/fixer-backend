const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");
const { verifyPayment } = require("../../services/paystackService");

beforeEach(() => {
  db.__reset();
  verifyPayment.mockClear();
});

const validShipment = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "0800",
  device: "iPhone 13",
  brand: "Apple",
  fault: "Cracked screen",
  address: "1 Main St",
  city: "Abuja",
  pickup_date: "2026-10-01",
  pickup_time: "10:00",
  payment_reference: "ref_1",
};

describe("POST /api/shipments", () => {
  it("401s with no token", async () => {
    const res = await request(app).post("/api/shipments").send(validShipment);
    expect(res.status).toBe(401);
  });

  it("400s a missing field", async () => {
    const res = await request(app)
      .post("/api/shipments")
      .set("Authorization", authHeader({ role: "user" }))
      .send({ name: "Ada" });
    expect(res.status).toBe(400);
  });

  it("402s on failed payment verification", async () => {
    verifyPayment.mockRejectedValueOnce(new Error("Payment was not successful."));

    const res = await request(app)
      .post("/api/shipments")
      .set("Authorization", authHeader({ role: "user" }))
      .send(validShipment);

    expect(res.status).toBe(402);
    expect(verifyPayment).toHaveBeenCalledWith("ref_1", 250000);
  });

  it("creates a shipment on successful payment", async () => {
    db.query
      .mockResolvedValueOnce([{ insertId: 3 }])
      .mockResolvedValueOnce([{}]);

    const res = await request(app)
      .post("/api/shipments")
      .set("Authorization", authHeader({ role: "user" }))
      .send(validShipment);

    expect(res.status).toBe(201);
    expect(res.body.reference).toBe("FXR-1003");
  });
});

describe("GET /api/shipments (admin-only)", () => {
  it("403s for a customer", async () => {
    const res = await request(app)
      .get("/api/shipments")
      .set("Authorization", authHeader({ role: "user" }));
    expect(res.status).toBe(403);
  });

  it("200s for an admin", async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app)
      .get("/api/shipments")
      .set("Authorization", authHeader({ role: "admin" }));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/shipments/:id", () => {
  it("403s when the shipment's email doesn't match the caller's", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, email: "someoneelse@example.com" }]]);

    const res = await request(app)
      .get("/api/shipments/1")
      .set("Authorization", authHeader({ email: "ada@example.com", role: "user" }));

    expect(res.status).toBe(403);
  });

  it("200s when the shipment belongs to the caller", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, email: "ada@example.com" }]]);

    const res = await request(app)
      .get("/api/shipments/1")
      .set("Authorization", authHeader({ email: "ada@example.com", role: "user" }));

    expect(res.status).toBe(200);
  });

  it("lets an admin view any shipment", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, email: "someoneelse@example.com" }]]);

    const res = await request(app)
      .get("/api/shipments/1")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
  });
});

describe("GET /api/shipments/user/:email", () => {
  it("403s when requesting someone else's email", async () => {
    const res = await request(app)
      .get("/api/shipments/user/someoneelse@example.com")
      .set("Authorization", authHeader({ email: "ada@example.com", role: "user" }));

    expect(res.status).toBe(403);
  });

  it("200s for the caller's own email (case-insensitive)", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1 }]]);

    const res = await request(app)
      .get("/api/shipments/user/ADA@EXAMPLE.COM")
      .set("Authorization", authHeader({ email: "ada@example.com", role: "user" }));

    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/shipments/:id/status", () => {
  it("403s for a customer", async () => {
    const res = await request(app)
      .patch("/api/shipments/1/status")
      .set("Authorization", authHeader({ role: "user" }))
      .send({ status: "in_transit" });
    expect(res.status).toBe(403);
  });

  it("200s for a technician", async () => {
    db.query.mockResolvedValueOnce([{}]);

    const res = await request(app)
      .patch("/api/shipments/1/status")
      .set("Authorization", authHeader({ role: "technician" }))
      .send({ status: "in_transit" });

    expect(res.status).toBe(200);
  });
});
