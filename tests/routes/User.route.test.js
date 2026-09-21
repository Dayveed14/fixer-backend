const request = require("supertest");
const bcrypt = require("bcrypt");
const { app, db, authHeader } = require("../helpers/testApp");

beforeEach(() => {
  db.__reset();
});

describe("POST /api/users/register", () => {
  it("rejects a missing required field", async () => {
    const res = await request(app)
      .post("/api/users/register")
      .send({ first_name: "Ada", email: "ada@example.com" });

    expect(res.status).toBe(400);
  });

  it("rejects an email that's already registered", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1 }]]); // SELECT id FROM users WHERE email = ?

    const res = await request(app).post("/api/users/register").send({
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      password: "password123",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already exists/i);
  });

  it("registers a new user", async () => {
    db.query
      .mockResolvedValueOnce([[]]) // email check: nobody found
      .mockResolvedValueOnce([{ insertId: 42 }]); // INSERT

    const res = await request(app).post("/api/users/register").send({
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      phone: "08000000000",
      password: "password123",
    });

    expect(res.status).toBe(201);
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/users/login", () => {
  it("rejects missing credentials", async () => {
    const res = await request(app).post("/api/users/login").send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown email", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post("/api/users/login")
      .send({ email: "nobody@example.com", password: "whatever" });

    expect(res.status).toBe(404);
  });

  it("returns 401 for the wrong password", async () => {
    const hashed = await bcrypt.hash("correct-password", 10);
    db.query.mockResolvedValueOnce([
      [{ id: 1, email: "ada@example.com", password: hashed, role: "user" }],
    ]);

    const res = await request(app)
      .post("/api/users/login")
      .send({ email: "ada@example.com", password: "wrong-password" });

    expect(res.status).toBe(401);
  });

  it("logs in and sets an httpOnly session cookie (no token in the response body)", async () => {
    const hashed = await bcrypt.hash("correct-password", 10);
    db.query.mockResolvedValueOnce([
      [
        {
          id: 1,
          first_name: "Ada",
          last_name: "Lovelace",
          email: "ada@example.com",
          phone: "0800",
          password: hashed,
          role: "user",
        },
      ],
    ]);

    const res = await request(app)
      .post("/api/users/login")
      .send({ email: "ada@example.com", password: "correct-password" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
    expect(res.body.role).toBe("user");

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieHeader = setCookie.find((c) => c.startsWith("fixer_token="));
    expect(cookieHeader).toBeDefined();
    expect(cookieHeader).toMatch(/HttpOnly/i);

    // The cookie should actually work against a protected route — pull
    // just "fixer_token=..." back out to replay as a Cookie header,
    // the way a real browser would on the next request.
    const cookieValue = cookieHeader.split(";")[0];

    const followUp = await request(app)
      .get("/api/users/technicians")
      .set("Cookie", cookieValue);
    expect(followUp.status).toBe(200);
  });
});

describe("POST /api/users/logout", () => {
  it("clears the session cookie", async () => {
    const res = await request(app).post("/api/users/logout");

    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    // Clearing a cookie is done by re-sending it with an immediate
    // expiry — Express's clearCookie sets Expires to the epoch.
    expect(setCookie[0]).toMatch(/fixer_token=;/);
  });
});

describe("GET /api/users/me", () => {
  it("401s with no token", async () => {
    const res = await request(app).get("/api/users/me");
    expect(res.status).toBe(401);
  });

  it("returns the caller's own profile from the cookie or header", async () => {
    db.query.mockResolvedValueOnce([
      [{ id: 3, first_name: "Ada", last_name: "L", email: "ada@x.com", phone: "0800", role: "user" }],
    ]);

    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(3);
  });
});

describe("POST /api/users/create (admin-only)", () => {
  it("401s with no token", async () => {
    const res = await request(app).post("/api/users/create").send({});
    expect(res.status).toBe(401);
  });

  it("403s for a non-admin", async () => {
    const res = await request(app)
      .post("/api/users/create")
      .set("Authorization", authHeader({ role: "user" }))
      .send({
        first_name: "Tech",
        last_name: "One",
        email: "tech@example.com",
        password: "password123",
        role: "technician",
      });

    expect(res.status).toBe(403);
  });

  it("lets an admin create a technician", async () => {
    db.query
      .mockResolvedValueOnce([[]]) // email check
      .mockResolvedValueOnce([{ insertId: 7 }]); // insert

    const res = await request(app)
      .post("/api/users/create")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({
        first_name: "Tech",
        last_name: "One",
        email: "tech@example.com",
        password: "password123",
        role: "technician",
      });

    expect(res.status).toBe(201);
  });

  it("rejects an invalid role even from an admin", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post("/api/users/create")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({
        first_name: "X",
        last_name: "Y",
        email: "x@example.com",
        password: "password123",
        role: "admin", // not in the allowed list — admins aren't self-service-created
      });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/users/technicians", () => {
  it("401s with no token", async () => {
    const res = await request(app).get("/api/users/technicians");
    expect(res.status).toBe(401);
  });

  it("is reachable by any authenticated role (customers pick a technician when booking)", async () => {
    db.query.mockResolvedValueOnce([
      [{ id: 2, first_name: "Tobi", role: "technician" }],
    ]);

    const res = await request(app)
      .get("/api/users/technicians")
      .set("Authorization", authHeader({ role: "user" }));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("GET /api/users (admin-only)", () => {
  it("401s with no token", async () => {
    const res = await request(app).get("/api/users");
    expect(res.status).toBe(401);
  });

  it("403s for a technician", async () => {
    const res = await request(app)
      .get("/api/users")
      .set("Authorization", authHeader({ role: "technician" }));

    expect(res.status).toBe(403);
  });

  it("200s for an admin", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]]);

    const res = await request(app)
      .get("/api/users")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});
