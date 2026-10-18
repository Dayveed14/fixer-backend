// Priority 1 — authentication and authorization across the whole API.
// One table of every protected endpoint, checked for: no session,
// invalid/expired/forged tokens, and the wrong role.
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { app, db, authHeader } = require("../helpers/testApp");

beforeEach(() => db.__reset());

const call = (method, path) => request(app)[method](path);

// [method, path, rolesAllowed] — "any" means any authenticated role.
const PROTECTED = [
  ["get", "/api/users/me", "any"],
  ["get", "/api/users/technicians", "any"],
  ["get", "/api/users", ["admin"]],
  ["post", "/api/users/create", ["admin"]],
  ["get", "/api/articles", ["admin"]],
  ["post", "/api/articles", ["admin"]],
  ["put", "/api/articles/1", ["admin"]],
  ["delete", "/api/articles/1", ["admin"]],
  ["get", "/api/diy-videos", ["admin"]],
  ["post", "/api/diy-videos", ["admin"]],
  ["put", "/api/diy-videos/1", ["admin"]],
  ["delete", "/api/diy-videos/1", ["admin"]],
  ["post", "/api/bookings", "any"],
  ["get", "/api/bookings", "any"],
  ["get", "/api/bookings/1", "any"],
  ["patch", "/api/bookings/1/assign", ["admin"]],
  ["patch", "/api/bookings/1/status", "any"],
  ["post", "/api/bookings/1/remote-session", ["admin", "technician"]],
  ["post", "/api/shipments", "any"],
  ["get", "/api/shipments", ["admin"]],
  ["get", "/api/shipments/user/a@b.com", "any"],
  ["get", "/api/shipments/1", "any"],
  ["patch", "/api/shipments/1/status", ["admin"]],
  ["get", "/api/shipments/assigned", ["admin", "technician"]],
  ["post", "/api/shipments/1/repair-result", ["admin", "technician"]],
  ["post", "/api/bookings/1/meeting", ["admin", "technician"]],
  ["get", "/api/articles/manage/some-slug", ["admin"]],
  ["get", "/api/diy-videos/manage/1", ["admin"]],
  ["post", "/api/tickets", ["admin", "technician"]],
  ["get", "/api/tickets", "any"],
  ["get", "/api/tickets/1", "any"],
  ["get", "/api/tickets/active/1", "any"],
  ["patch", "/api/tickets/1/status", ["admin", "technician"]],
  ["patch", "/api/tickets/1/assign", ["admin"]],
  ["patch", "/api/tickets/1", ["admin"]],
  ["delete", "/api/tickets/1", ["admin"]],
  ["post", "/api/ratings", ["user"]],
  ["post", "/api/devices", "any"],
  ["get", "/api/devices", "any"],
  ["patch", "/api/devices/1/service", "any"],
  ["delete", "/api/devices/1", "any"],
  ["get", "/api/notifications", "any"],
  ["patch", "/api/notifications/1/read", "any"],
  ["patch", "/api/notifications/read-all", "any"],
  ["get", "/api/stats/dashboard", ["admin"]],
  ["get", "/api/stats/user/1", "any"],
  ["get", "/api/stats/technician/1", ["admin", "technician"]],
  ["get", "/api/test/mesh/test", ["admin"]],
  ["post", "/api/payments/initialize", ["user"]],
  ["get", "/api/payments", ["admin"]],
  ["get", "/api/payments/FXB_1", "any"],
  ["get", "/api/payments/FXB_1/events", ["admin"]],
  ["get", "/api/pricing", ["admin"]],
  ["put", "/api/pricing/support-types", ["admin"]],
  ["put", "/api/pricing/zones", ["admin"]],
  ["put", "/api/pricing/settings", ["admin"]],
  ["post", "/api/shipments/1/quote", ["admin"]],
  ["post", "/api/shipments/1/approval", "any"],
  ["post", "/api/shipments/1/confirm-delivery", "any"],
];

const ROLES = ["user", "technician", "admin"];

describe.each(PROTECTED)("%s %s", (method, path, allowed) => {
  it("401s with no session", async () => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
  });

  it("401s with a token signed by someone else", async () => {
    const forged = jwt.sign({ id: 1, role: "admin" }, "not-the-real-secret");
    const res = await call(method, path).set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it("401s with an expired token", async () => {
    const expired = jwt.sign(
      { id: 1, role: "admin", exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET,
    );
    const res = await call(method, path).set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  if (allowed !== "any") {
    const denied = ROLES.filter((r) => !allowed.includes(r));
    it.each(denied)("403s for role %s", async (role) => {
      const res = await call(method, path).set("Authorization", authHeader({ role }));
      expect(res.status).toBe(403);
    });
  }
});

describe("tokens", () => {
  it("rejects alg=none tokens", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ id: 1, role: "admin" })).toString("base64url");
    const res = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${header}.${payload}.`);
    expect(res.status).toBe(401);
  });

  it("ignores a role claimed in the request body", async () => {
    const res = await request(app)
      .get("/api/users")
      .set("Authorization", authHeader({ role: "user" }))
      .send({ role: "admin" });
    expect(res.status).toBe(403);
  });
});

describe("public endpoints stay public", () => {
  it.each([
    ["get", "/api/articles/published"],
    ["get", "/api/diy-videos/published"],
    ["get", "/api/shipments/zones"],
    ["get", "/api/bookings/support-types"],
    ["get", "/api/health"],
    ["get", "/api/ratings/technician/1"],
  ])("%s %s", async (method, path) => {
    const res = await call(method, path);
    expect([401, 403]).not.toContain(res.status);
  });
});
