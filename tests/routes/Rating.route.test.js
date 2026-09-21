const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");

beforeEach(() => {
  db.__reset();
});

describe("POST /api/ratings (customer-only)", () => {
  it("401s with no token", async () => {
    const res = await request(app).post("/api/ratings").send({});
    expect(res.status).toBe(401);
  });

  it("403s for a technician (only customers rate)", async () => {
    const res = await request(app)
      .post("/api/ratings")
      .set("Authorization", authHeader({ role: "technician" }))
      .send({ ticket_id: 1, technician_id: 7, rating: 5 });
    expect(res.status).toBe(403);
  });

  it("400s a rating out of range", async () => {
    const res = await request(app)
      .post("/api/ratings")
      .set("Authorization", authHeader({ role: "user" }))
      .send({ ticket_id: 1, technician_id: 7, rating: 9 });
    expect(res.status).toBe(400);
  });

  it("404s when the ticket doesn't exist", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post("/api/ratings")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ ticket_id: 999, technician_id: 7, rating: 5 });

    expect(res.status).toBe(404);
  });

  it("403s rating a ticket that isn't the caller's", async () => {
    db.query.mockResolvedValueOnce([[{ customer_id: 999, technician_id: 7 }]]);

    const res = await request(app)
      .post("/api/ratings")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ ticket_id: 1, technician_id: 7, rating: 5 });

    expect(res.status).toBe(403);
  });

  it("400s when technician_id doesn't match the ticket's actual technician", async () => {
    db.query.mockResolvedValueOnce([[{ customer_id: 3, technician_id: 7 }]]);

    const res = await request(app)
      .post("/api/ratings")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ ticket_id: 1, technician_id: 999, rating: 5 });

    expect(res.status).toBe(400);
  });

  it("submits a valid rating, always as the caller's own customer_id", async () => {
    db.query
      .mockResolvedValueOnce([[{ customer_id: 3, technician_id: 7 }]])
      .mockResolvedValueOnce([{ insertId: 1 }]);

    const res = await request(app)
      .post("/api/ratings")
      .set("Authorization", authHeader({ id: 3, role: "user" }))
      .send({ ticket_id: 1, technician_id: 7, rating: 5, comment: "Great!" });

    expect(res.status).toBe(201);
    const insertParams = db.query.mock.calls[1][1];
    expect(insertParams[2]).toBe(3); // customer_id bound param
  });
});

describe("GET /api/ratings/technician/:technicianId (public)", () => {
  it("200s with no auth required", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, rating: 5 }]]);

    const res = await request(app).get("/api/ratings/technician/7");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});
