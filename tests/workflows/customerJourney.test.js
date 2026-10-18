// Priority 3 — a customer's journey through the core workflows, step
// by step: register -> log in -> pay -> book -> admin assigns ->
// technician resolves the ticket -> customer rates.
const request = require("supertest");
const bcrypt = require("bcrypt");
const { app, db, authHeader } = require("../helpers/testApp");
const { routeQueries } = require("../helpers/sqlRouter");
const { tomorrow } = require("../helpers/dates");
const { verifyTransaction } = require("../../services/paystackService");

const CUSTOMER = { id: 3, email: "ada@example.com", role: "user" };
const TECH = { id: 5, email: "tech@example.com", role: "technician" };
const ADMIN = { id: 1, email: "admin@example.com", role: "admin" };

beforeEach(() => db.__reset());

it("register -> login -> pay -> book -> assign -> resolve -> rate", async () => {
  // 1. Register
  db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([{ insertId: 3 }]);
  const reg = await request(app).post("/api/users/register").send({
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ADA@example.com ",
    password: "password123",
  });
  expect(reg.status).toBe(201);

  // 2. Log in (session cookie, no token in body)
  const hash = await bcrypt.hash("password123", 4);
  db.query.mockResolvedValueOnce([[{ id: 3, first_name: "Ada", last_name: "L", email: "ada@example.com", password: hash, role: "user" }]]);
  const login = await request(app).post("/api/users/login").send({ email: "ada@example.com", password: "password123" });
  expect(login.status).toBe(200);
  expect(login.headers["set-cookie"].join(";")).toMatch(/fixer_token=.*HttpOnly/i);
  expect(login.body.token).toBeUndefined();

  // 3. Initialise payment for a remote-support call tomorrow at 10:00
  db.__reset();
  const init = await request(app)
    .post("/api/payments/initialize")
    .set("Authorization", authHeader(CUSTOMER))
    .send({ purpose: "booking", support_type: "remote", booking_date: tomorrow(), booking_time: "10:00" });
  expect(init.status).toBe(201);
  expect(init.body.amount).toBe(10000);
  const { reference } = init.body;
  const [, insertParams] = db.query.mock.calls.find(([sql]) => /INSERT INTO payment_transactions/.test(sql));

  // 4. Customer pays on Paystack, then submits the booking
  db.__reset();
  verifyTransaction.mockResolvedValueOnce({ status: "success", currency: "NGN", amount: 1000000 });
  const paymentRow = {
    reference,
    user_id: 3,
    purpose: "booking",
    amount_kobo: insertParams[4],
    currency: "NGN",
    status: "pending",
    entity_id: null,
    metadata: insertParams[5],
  };
  routeQueries(db.query, [
    [/FROM users WHERE id/, [[{ first_name: "Ada", last_name: "L", email: "ada@example.com" }]]],
    [/SELECT \* FROM payment_transactions/, [[paymentRow]]],
  ]);
  routeQueries(db.mockConnection.query, [
    [/FOR UPDATE/, [[{ status: "success", entity_id: null }]]],
    [/INSERT INTO bookings/, [{ insertId: 20 }]],
  ]);
  const booking = await request(app)
    .post("/api/bookings")
    .set("Authorization", authHeader(CUSTOMER))
    .send({ support_type: "remote", booking_date: tomorrow(), booking_time: "10:00", payment_reference: reference });
  expect(booking.status).toBe(201);
  expect(booking.body.booking_reference).toBe("#BK1020");

  // 5. Admin assigns a technician -> booking confirmed, ticket created
  db.__reset();
  db.mockConnection.query
    .mockResolvedValueOnce([[{ id: 20, user_id: 3, booking_reference: "#BK1020", ticket_id: null, customer_name: "Ada L" }]])
    .mockResolvedValueOnce([[{ first_name: "Tee", last_name: "Tech", email: "tech@example.com" }]])
    .mockResolvedValueOnce([{ insertId: 30 }]);
  const assign = await request(app)
    .patch("/api/bookings/20/assign")
    .set("Authorization", authHeader(ADMIN))
    .send({ technician_id: 5 });
  expect(assign.status).toBe(200);
  expect(assign.body.ticket_id).toBe(30);

  // 6. Technician resolves the ticket
  db.__reset();
  db.query.mockResolvedValueOnce([[{ technician_id: 5 }]]);
  const resolve = await request(app)
    .patch("/api/tickets/30/status")
    .set("Authorization", authHeader(TECH))
    .send({ status: "Completed" });
  expect(resolve.status).toBe(200);

  // 7. Customer rates the technician
  db.__reset();
  db.query
    .mockResolvedValueOnce([[{ customer_id: 3, technician_id: 5 }]])
    .mockResolvedValueOnce([{ insertId: 1 }]);
  const rating = await request(app)
    .post("/api/ratings")
    .set("Authorization", authHeader(CUSTOMER))
    .send({ ticket_id: 30, technician_id: 5, rating: 5, comment: "Great" });
  expect(rating.status).toBe(201);
});

describe("registration validation", () => {
  it.each([
    ["a short password", { password: "short" }],
    ["an invalid email", { email: "not-an-email" }],
    ["a non-string field", { first_name: { $ne: null } }],
    ["an overlong name", { first_name: "x".repeat(81) }],
  ])("400s %s", async (_label, override) => {
    const res = await request(app).post("/api/users/register").send({
      first_name: "Ada",
      last_name: "L",
      email: "ada@example.com",
      password: "password123",
      ...override,
    });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});
