// Session lifetime and revocation, with the real sessionService and
// auth middleware (only the database is mocked).
jest.mock("../../config/db");

const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const db = require("../../config/db");
const { verifyToken } = require("../../middleware/auth");
const { clearSessionCache, invalidateSession } = require("../../services/sessionService");

const app = express();
app.use(cookieParser());
app.get("/private", verifyToken, (req, res) => res.json({ id: req.user.id }));

const sign = (claims = {}, options = {}) =>
  jwt.sign({ id: 1, email: "a@example.com", role: "user", tv: 0, ...claims }, process.env.JWT_SECRET, {
    expiresIn: "1h",
    ...options,
  });

const userRow = (row = {}) => [[{ token_version: 0, role: "user", ...row }]];

beforeEach(() => {
  db.__reset();
  clearSessionCache();
});

describe("session expiry and token integrity", () => {
  it("accepts a current session", async () => {
    db.query.mockResolvedValueOnce(userRow());
    const res = await request(app).get("/private").set("Authorization", `Bearer ${sign()}`);
    expect(res.status).toBe(200);
  });

  it("rejects an expired token and clears the cookie", async () => {
    const expired = sign({}, { expiresIn: -10 });
    const res = await request(app).get("/private").set("Cookie", `fixer_token=${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/expired/i);
    expect(res.headers["set-cookie"].join(";")).toMatch(/fixer_token=;.*Expires=Thu, 01 Jan 1970/);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects an unsigned (alg: none) token", async () => {
    const unsigned = jwt.sign({ id: 1, role: "admin" }, null, { algorithm: "none" });
    const res = await request(app).get("/private").set("Authorization", `Bearer ${unsigned}`);
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with another secret", async () => {
    const forged = jwt.sign({ id: 1, role: "admin" }, "not-the-secret");
    const res = await request(app).get("/private").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with HS512 even with the right secret (algorithm pinned)", async () => {
    const other = jwt.sign({ id: 1, role: "user", tv: 0 }, process.env.JWT_SECRET, { algorithm: "HS512" });
    const res = await request(app).get("/private").set("Authorization", `Bearer ${other}`);
    expect(res.status).toBe(401);
  });

  it("does not clear anything for a Bearer token (nothing to clear)", async () => {
    const res = await request(app).get("/private").set("Authorization", `Bearer ${sign({}, { expiresIn: -10 })}`);
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

describe("session revocation", () => {
  it("ends sessions issued before a password change", async () => {
    db.query.mockResolvedValueOnce(userRow({ token_version: 1 }));
    const res = await request(app).get("/private").set("Authorization", `Bearer ${sign({ tv: 0 })}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/session ended/i);
  });

  it("treats a token without tv as version 0 (sessions from before this release keep working)", async () => {
    db.query.mockResolvedValueOnce(userRow());
    const token = jwt.sign({ id: 1, role: "user" }, process.env.JWT_SECRET);
    const res = await request(app).get("/private").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("ends sessions when the role changed (e.g. a demoted admin)", async () => {
    db.query.mockResolvedValueOnce(userRow({ role: "user" }));
    const res = await request(app).get("/private").set("Authorization", `Bearer ${sign({ role: "admin" })}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/access has changed/i);
  });

  it("ends sessions for a deleted account", async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app).get("/private").set("Authorization", `Bearer ${sign()}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/no longer exists/i);
  });

  it("caches the lookup, and invalidateSession forces a fresh one", async () => {
    db.query.mockResolvedValue(userRow());
    const auth = `Bearer ${sign()}`;

    await request(app).get("/private").set("Authorization", auth);
    await request(app).get("/private").set("Authorization", auth);
    expect(db.query).toHaveBeenCalledTimes(1);

    invalidateSession(1);
    db.query.mockResolvedValue(userRow({ token_version: 5 }));
    const res = await request(app).get("/private").set("Authorization", auth);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(401);
  });

  it("works before the token_version migration (role check only)", async () => {
    db.query
      .mockRejectedValueOnce(Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR" }))
      .mockResolvedValueOnce([[{ role: "user" }]]);
    const res = await request(app).get("/private").set("Authorization", `Bearer ${sign({ tv: 3 })}`);
    expect(res.status).toBe(200);
  });

  it("returns 503 (not 401) if the database is down, so users aren't logged out", async () => {
    db.query.mockRejectedValueOnce(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const res = await request(app).get("/private").set("Authorization", `Bearer ${sign()}`);
    expect(res.status).toBe(503);
  });
});
