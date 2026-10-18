// Rate-limit enforcement. These env values must be set BEFORE the app
// (and so middleware/rateLimit.js) is loaded for this test file.
process.env.DIAGNOSIS_RATE_LIMIT_GUEST = "2";
process.env.DIAGNOSIS_RATE_LIMIT_USER = "3";
process.env.LOGIN_RATE_LIMIT = "2";
process.env.PAYMENT_RATE_LIMIT = "2";

const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");

beforeEach(() => db.__reset());

const diag = { deviceType: "Laptop", primaryFault: "Overheating" };

it("limits guest FixBot requests per IP", async () => {
  db.query.mockResolvedValue([{ insertId: 1 }]);
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    statuses.push((await request(app).post("/api/diagnosis/run").send({ ...diag, description: "" })).status);
  }
  expect(statuses.slice(0, 2)).not.toContain(429);
  expect(statuses[2]).toBe(429);
});

it("limits signed-in FixBot callers per account (not per shared IP)", async () => {
  db.query.mockResolvedValue([{ insertId: 1 }]);
  const asUser = (id) =>
    request(app).post("/api/diagnosis/run").set("Authorization", authHeader({ id, role: "user" })).send(diag);

  for (let i = 0; i < 3; i++) expect((await asUser(50)).status).not.toBe(429);
  expect((await asUser(50)).status).toBe(429);
  // A different account on the same IP is unaffected.
  expect((await asUser(51)).status).not.toBe(429);
});

it("returns a JSON message FixBot can show", async () => {
  db.query.mockResolvedValue([{ insertId: 1 }]);
  let res;
  for (let i = 0; i < 6; i++) res = await request(app).post("/api/diagnosis/run").send(diag);
  expect(res.status).toBe(429);
  expect(res.body.code).toBe("RATE_LIMITED");
});

it("limits login attempts", async () => {
  const attempt = () => request(app).post("/api/users/login").send({ email: "a@b.com", password: "x" });
  await attempt();
  await attempt();
  expect((await attempt()).status).toBe(429);
});

it("limits payment initialisation per account", async () => {
  const init = () =>
    request(app)
      .post("/api/payments/initialize")
      .set("Authorization", authHeader({ id: 70, role: "user" }))
      .send({ purpose: "nope" });
  await init();
  await init();
  expect((await init()).status).toBe(429);
});
