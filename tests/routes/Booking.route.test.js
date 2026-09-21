const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");
const { verifyPayment } = require("../../services/paystackService");
const { generateInviteLink } = require("../../services/meshCentralService");

beforeEach(() => {
  db.__reset();
  verifyPayment.mockClear();
  generateInviteLink.mockClear();
});

const validBookingBody = {
  support_type: "voice",
  booking_date: "2026-10-01",
  booking_time: "10:00",
  payment_reference: "ref_123",
};

describe("POST /api/bookings", () => {
  it("401s with no token", async () => {
    const res = await request(app).post("/api/bookings").send(validBookingBody);
    expect(res.status).toBe(401);
  });

  it("rejects a missing required field", async () => {
    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ support_type: "voice" });

    expect(res.status).toBe(400);
  });

  it("rejects an invalid support_type", async () => {
    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ ...validBookingBody, support_type: "carrier_pigeon" });

    expect(res.status).toBe(400);
  });

  it("402s when Paystack can't verify the payment", async () => {
    verifyPayment.mockRejectedValueOnce(new Error("Payment amount mismatch."));

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send(validBookingBody);

    expect(res.status).toBe(402);
    expect(verifyPayment).toHaveBeenCalledWith("ref_123", 500000);
  });

  it("creates a booking for the logged-in customer, ignoring any user_id in the body", async () => {
    db.query
      .mockResolvedValueOnce([[{ first_name: "Ada", last_name: "L", email: "ada@x.com" }]]) // customer lookup
      .mockResolvedValueOnce([{ insertId: 55 }]) // insert booking
      .mockResolvedValueOnce([{}]); // update booking_reference

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ ...validBookingBody, user_id: 999 }); // attempted spoof

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(55);

    // The INSERT's second bound param is user_id — must be 3 (the token),
    // never 999 (the spoofed body value).
    const insertCall = db.query.mock.calls[1];
    expect(insertCall[1][1]).toBe(3);
  });
});

describe("GET /api/bookings", () => {
  it("401s with no token", async () => {
    const res = await request(app).get("/api/bookings");
    expect(res.status).toBe(401);
  });

  it("forces a customer's query to their own user_id even if they pass another", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get("/api/bookings?user_id=999")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/bookings\.user_id = \?/);
    expect(params).toContain(3);
    expect(params).not.toContain(999);
  });

  it("forces a technician's query to their own technician_id", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get("/api/bookings?technician_id=999")
      .set("Authorization", authHeader({ id: 7, role: "technician" }));

    expect(res.status).toBe(200);
    const [, params] = db.query.mock.calls[0];
    expect(params).toContain(7);
    expect(params).not.toContain(999);
  });

  it("lets an admin filter by any id", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get("/api/bookings?user_id=42")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
    const [, params] = db.query.mock.calls[0];
    expect(params).toContain(42);
  });
});

describe("GET /api/bookings/:id", () => {
  it("404s when the booking doesn't exist", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get("/api/bookings/999")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(404);
  });

  it("403s a customer viewing someone else's booking", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, user_id: 999, technician_id: null }]]);

    const res = await request(app)
      .get("/api/bookings/1")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(403);
  });

  it("200s for the owning customer", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, user_id: 3, technician_id: null }]]);

    const res = await request(app)
      .get("/api/bookings/1")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(200);
  });

  it("200s for the assigned technician", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, user_id: 3, technician_id: 7 }]]);

    const res = await request(app)
      .get("/api/bookings/1")
      .set("Authorization", authHeader({ id: 7, role: "technician" }));

    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/bookings/:id/assign (admin-only)", () => {
  it("401s with no token", async () => {
    const res = await request(app)
      .patch("/api/bookings/1/assign")
      .send({ technician_id: 7 });
    expect(res.status).toBe(401);
  });

  it("403s for a technician", async () => {
    const res = await request(app)
      .patch("/api/bookings/1/assign")
      .set("Authorization", authHeader({ role: "technician" }))
      .send({ technician_id: 7 });
    expect(res.status).toBe(403);
  });

  it("assigns a technician and links a new ticket for an admin", async () => {
    db.mockConnection.query
      .mockResolvedValueOnce([
        [
          {
            id: 1,
            user_id: 3,
            booking_reference: "#BK1001",
            ticket_id: null,
            customer_name: "Ada L",
            customer_email: "ada@x.com",
          },
        ],
      ]) // booking lookup
      .mockResolvedValueOnce([[{ first_name: "Tobi", last_name: "T", email: "tobi@x.com" }]]) // technician lookup
      .mockResolvedValueOnce([{ insertId: 9 }]) // insert ticket
      .mockResolvedValueOnce([{}]) // update ticket_code
      .mockResolvedValueOnce([{}]); // update booking

    const res = await request(app)
      .patch("/api/bookings/1/assign")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ technician_id: 7 });

    expect(res.status).toBe(200);
    expect(res.body.ticket_id).toBe(9);
    expect(db.mockConnection.commit).toHaveBeenCalled();
    expect(db.mockConnection.rollback).not.toHaveBeenCalled();
  });

  it("rolls back if the technician doesn't exist", async () => {
    db.mockConnection.query
      .mockResolvedValueOnce([[{ id: 1, user_id: 3, ticket_id: null }]]) // booking lookup
      .mockResolvedValueOnce([[]]); // technician lookup: not found

    const res = await request(app)
      .patch("/api/bookings/1/assign")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ technician_id: 999 });

    expect(res.status).toBe(404);
    expect(db.mockConnection.rollback).toHaveBeenCalled();
  });
});

describe("PATCH /api/bookings/:id/status", () => {
  it("401s with no token", async () => {
    const res = await request(app)
      .patch("/api/bookings/1/status")
      .send({ status: "cancelled" });
    expect(res.status).toBe(401);
  });

  it("400s an unrecognised status", async () => {
    const res = await request(app)
      .patch("/api/bookings/1/status")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ status: "teleported" });
    expect(res.status).toBe(400);
  });

  it("lets a customer cancel their own booking", async () => {
    db.query
      .mockResolvedValueOnce([[{ user_id: 3 }]]) // ownership lookup
      .mockResolvedValueOnce([{}]); // update

    const res = await request(app)
      .patch("/api/bookings/1/status")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
  });

  it("blocks a customer from cancelling someone else's booking", async () => {
    db.query.mockResolvedValueOnce([[{ user_id: 999 }]]);

    const res = await request(app)
      .patch("/api/bookings/1/status")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ status: "cancelled" });

    expect(res.status).toBe(403);
  });

  it("blocks a customer from setting a non-cancel status", async () => {
    const res = await request(app)
      .patch("/api/bookings/1/status")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ status: "completed" });

    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("blocks a technician from updating a booking that isn't theirs", async () => {
    db.query.mockResolvedValueOnce([[{ technician_id: 999 }]]);

    const res = await request(app)
      .patch("/api/bookings/1/status")
      .set("Authorization", authHeader({ id: 7, role: "technician" }))
      .send({ status: "completed" });

    expect(res.status).toBe(403);
  });

  it("lets an admin set any status on any booking", async () => {
    db.query.mockResolvedValueOnce([{}]);

    const res = await request(app)
      .patch("/api/bookings/1/status")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ status: "missed" });

    expect(res.status).toBe(200);
  });
});

describe("POST /api/bookings/:id/remote-session", () => {
  it("403s a technician not assigned to the booking", async () => {
    db.query.mockResolvedValueOnce([
      [{ id: 1, status: "confirmed", technician_id: 999 }],
    ]);

    const res = await request(app)
      .post("/api/bookings/1/remote-session")
      .set("Authorization", authHeader({ id: 7, role: "technician" }));

    expect(res.status).toBe(403);
  });

  it("400s if the booking isn't confirmed yet", async () => {
    db.query.mockResolvedValueOnce([
      [{ id: 1, status: "pending", technician_id: 7 }],
    ]);

    const res = await request(app)
      .post("/api/bookings/1/remote-session")
      .set("Authorization", authHeader({ id: 7, role: "technician" }));

    expect(res.status).toBe(400);
  });

  it("generates an invite link for the assigned technician", async () => {
    db.query.mockResolvedValueOnce([
      [
        {
          id: 1,
          status: "confirmed",
          technician_id: 7,
          customer_email: "ada@x.com",
          customer_name: "Ada",
          booking_reference: "#BK1001",
        },
      ],
    ]);

    const res = await request(app)
      .post("/api/bookings/1/remote-session")
      .set("Authorization", authHeader({ id: 7, role: "technician" }));

    expect(res.status).toBe(200);
    expect(res.body.inviteLink).toEqual(expect.any(String));
    expect(generateInviteLink).toHaveBeenCalled();
  });
});
