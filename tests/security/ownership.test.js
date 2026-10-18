// Priority 1 — record ownership and ID manipulation. Complements the
// per-resource ownership tests in tests/routes/.
const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");
const { callsMatching } = require("../helpers/sqlRouter");

beforeEach(() => db.__reset());

const ada = authHeader({ id: 3, email: "ada@example.com", role: "user" });

it("registration can't self-assign a staff role", async () => {
  db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([{ insertId: 9 }]);
  const res = await request(app).post("/api/users/register").send({
    first_name: "Eve",
    last_name: "X",
    email: "eve@example.com",
    password: "password123",
    role: "admin",
  });
  expect(res.status).toBe(201);
  const [insert] = callsMatching(db.query, /INSERT INTO users/);
  expect(insert[0]).not.toMatch(/role/);
  expect(insert[1]).not.toContain("admin");
});

it("a customer listing bookings can't widen the query with another user_id", async () => {
  await request(app).get("/api/bookings?user_id=8").set("Authorization", ada);
  const [, params] = db.query.mock.calls[0];
  expect(params).toContain(3);
  expect(params).not.toContain(8);
});

it("a customer can't view another customer's booking by guessing the id", async () => {
  db.query.mockResolvedValueOnce([[{ id: 10, user_id: 8, technician_id: null }]]);
  const res = await request(app).get("/api/bookings/10").set("Authorization", ada);
  expect(res.status).toBe(403);
});

it("a customer can't cancel another customer's booking", async () => {
  db.query.mockResolvedValueOnce([[{ user_id: 8 }]]);
  const res = await request(app)
    .patch("/api/bookings/10/status")
    .set("Authorization", ada)
    .send({ status: "cancelled" });
  expect(res.status).toBe(403);
  expect(callsMatching(db.query, /UPDATE bookings/)).toHaveLength(0);
});

it("a customer can't read another customer's shipments by email", async () => {
  const res = await request(app)
    .get("/api/shipments/user/someone-else@example.com")
    .set("Authorization", ada);
  expect(res.status).toBe(403);
});

it("a technician can't move a booking that isn't assigned to them", async () => {
  db.query.mockResolvedValueOnce([[{ technician_id: 99 }]]);
  const res = await request(app)
    .patch("/api/bookings/10/status")
    .set("Authorization", authHeader({ id: 5, role: "technician" }))
    .send({ status: "completed" });
  expect(res.status).toBe(403);
});
