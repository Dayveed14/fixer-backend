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

describe("production start-up configuration", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..", "..");
  const pkg = require("../../package.json");

  it("starts with plain node in production (nodemon is a dev dependency)", () => {
    expect(pkg.scripts.start).toBe("node app.js");
    expect(pkg.dependencies.nodemon).toBeUndefined();
    expect(fs.existsSync(path.join(root, pkg.main))).toBe(true);
  });

  it("declares a Node version", () => {
    expect(pkg.engines.node).toMatch(/>=\s*20/);
  });

  it(".env.example documents every env var the app reads", () => {
    const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    const used = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "tests", ".git", "scripts"].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          const src = fs.readFileSync(full, "utf8");
          for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
          for (const m of src.matchAll(/env(?:Int|Number)\("([A-Z0-9_]+)"/g)) used.add(m[1]);
          for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
          for (const m of src.matchAll(/\b(MESHCENTRAL_[A-Z_]+)\b/g)) used.add(m[1]);
        }
      }
    };
    walk(root);
    const missing = [...used].filter((name) => !example.includes(name) && name !== "NODE_ENV_TEST");
    expect(missing).toEqual([]);
  });

  it("never commits real env files but keeps the example", () => {
    const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^!\.env\.example$/m);
  });

  it("uses TLS to the database unless DB_SSL=false", () => {
    const src = fs.readFileSync(path.join(root, "config", "db.js"), "utf8");
    expect(src).toMatch(/rejectUnauthorized: true/);
    expect(src).toMatch(/DB_SSL/);
  });
});
