// Priority 5 — deployment and integration readiness.
const request = require("supertest");
const { app, db } = require("../helpers/testApp");

beforeEach(() => db.__reset());

describe("health checks", () => {
  it("GET /api/health is a cheap liveness probe (no DB call)", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("GET /api/health/ready reports the database up", async () => {
    const res = await request(app).get("/api/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.database).toBe("up");
  });

  it("GET /api/health/ready returns 503 when the database is unreachable", async () => {
    db.query.mockRejectedValueOnce(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
    const res = await request(app).get("/api/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "unavailable", database: "down" });
  });

  it("GET /api/health/ready doesn't hang on a stuck connection", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    db.query.mockReturnValueOnce(new Promise(() => {}));
    const pending = request(app).get("/api/health/ready");
    const done = pending.then((r) => r);
    await new Promise((r) => setImmediate(r));
    jest.advanceTimersByTime(3100);
    jest.useRealTimers();
    const res = await done;
    expect(res.status).toBe(503);
  });
});

describe("request handling", () => {
  it("returns JSON 404 for unknown API routes", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Not found.");
  });

  it("returns 400 for malformed JSON instead of an HTML stack trace", async () => {
    const res = await request(app)
      .post("/api/users/login")
      .set("Content-Type", "application/json")
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Malformed JSON/);
  });

  it("rejects bodies over the size limit", async () => {
    const res = await request(app)
      .post("/api/contact")
      .send({ message: "x".repeat(150 * 1024) });
    expect(res.status).toBe(413);
  });

  it("refuses a disallowed CORS origin with 403 JSON", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
  });

  it("allows the production frontend origin with credentials", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://fixerng.app");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://fixerng.app");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});

describe("app module", () => {
  it("exports the app without starting a listener or touching the DB at import", () => {
    // testApp required app.js already; nothing should have queried the DB.
    jest.isolateModules(() => {
      const fresh = require("../../app");
      expect(typeof fresh.listen).toBe("function");
    });
    expect(db.query).not.toHaveBeenCalled();
  });
});
