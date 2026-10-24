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

  it("gives an unknown email the same 401 as a wrong password (no enumeration)", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post("/api/users/login")
      .send({ email: "nobody@example.com", password: "whatever" });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Incorrect email or password.");
  });

  it("rejects non-string credentials without touching the database", async () => {
    const res = await request(app)
      .post("/api/users/login")
      .send({ email: { $gt: "" }, password: ["x"] });

    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
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

describe("registration and staff-account validation", () => {
  it.each([
    [{ first_name: "Ada", last_name: "L", email: "not-an-email", password: "password123" }, /valid email/i],
    [{ first_name: "Ada", last_name: "L", email: "ada@example.com", password: "short" }, /8 and 72/],
    [{ first_name: "Ada", last_name: "L", email: "ada@example.com", password: "x".repeat(73) }, /8 and 72/],
    [{ first_name: "A".repeat(81), last_name: "L", email: "ada@example.com", password: "password123" }, /too long/i],
    [{ first_name: ["Ada"], last_name: "L", email: "ada@example.com", password: "password123" }, /invalid/i],
  ])("register rejects bad input %#", async (body, message) => {
    const res = await request(app).post("/api/users/register").send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("admin create-user applies the same rules", async () => {
    const res = await request(app)
      .post("/api/users/create")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ first_name: "T", last_name: "Ech", email: "t@example.com", password: "123", role: "technician" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/8 and 72/);
  });
});

describe("GET /api/users/technicians field exposure", () => {
  it("only gives non-admins technician names", async () => {
    db.query.mockResolvedValueOnce([[{ id: 3, first_name: "Tee", last_name: "Ech" }]]);

    const res = await request(app)
      .get("/api/users/technicians")
      .set("Authorization", authHeader({ role: "technician" }));

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[0][0]).not.toMatch(/email|phone/);
  });

  it("gives admins contact details", async () => {
    db.query.mockResolvedValueOnce([[]]);

    await request(app)
      .get("/api/users/technicians")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(db.query.mock.calls[0][0]).toMatch(/email, phone/);
  });
});

describe("PATCH /api/users/me/password", () => {
  const sessionService = require("../../services/sessionService");
  const sendMail = require("../../services/mailService");

  async function userRow(password = "old-password-1", extra = {}) {
    return { id: 1, first_name: "Ada", email: "ada@example.com", role: "user", token_version: 2, password: await bcrypt.hash(password, 4), ...extra };
  }

  it("requires a session", async () => {
    const res = await request(app)
      .patch("/api/users/me/password")
      .send({ current_password: "old-password-1", new_password: "new-password-1" });
    expect(res.status).toBe(401);
  });

  it.each(["technician", "admin", "user"])("lets a %s change their password, ends other sessions and reissues the cookie", async (role) => {
    db.query
      .mockResolvedValueOnce([[await userRow("old-password-1", { role })]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .patch("/api/users/me/password")
      .set("Authorization", authHeader({ id: 1, role }))
      .send({ current_password: "old-password-1", new_password: "new-password-1" });

    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/UPDATE users SET password = \?, token_version = \?/);
    expect(params[1]).toBe(3);
    expect(await bcrypt.compare("new-password-1", params[0])).toBe(true);
    expect(sessionService.invalidateSession).toHaveBeenCalledWith(1);

    const cookie = res.headers["set-cookie"].join(";");
    expect(cookie).toMatch(/fixer_token=/);
    const token = cookie.match(/fixer_token=([^;]+)/)[1];
    const jwt = require("jsonwebtoken");
    expect(jwt.decode(token).tv).toBe(3);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com" }), "support");
  });

  it("rejects a wrong current password", async () => {
    db.query.mockResolvedValueOnce([[await userRow()]]);

    const res = await request(app)
      .patch("/api/users/me/password")
      .set("Authorization", authHeader({ id: 1 }))
      .send({ current_password: "nope-nope-1", new_password: "new-password-1" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/incorrect/i);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ new_password: "new-password-1" }, /current password/i],
    [{ current_password: "old-password-1", new_password: "short" }, /8 and 72/],
    [{ current_password: "old-password-1", new_password: "old-password-1" }, /haven't just used/],
  ])("validates the request %#", async (body, message) => {
    const res = await request(app)
      .patch("/api/users/me/password")
      .set("Authorization", authHeader({ id: 1 }))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("still changes the password before the session migration has run", async () => {
    const missing = Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR" });
    db.query
      .mockResolvedValueOnce([[await userRow()]])
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .patch("/api/users/me/password")
      .set("Authorization", authHeader({ id: 1 }))
      .send({ current_password: "old-password-1", new_password: "new-password-1" });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][0]).toBe("UPDATE users SET password = ? WHERE id = ?");
  });
});

describe("admin user management", () => {
  const admin = () => authHeader({ id: 99, role: "admin" });
  const sessionService = require("../../services/sessionService");

  it.each([
    ["get", "/api/users/5"],
    ["patch", "/api/users/5"],
    ["delete", "/api/users/5"],
  ])("%s %s is admin-only", async (method, url) => {
    const res = await request(app)[method](url).set("Authorization", authHeader({ role: "technician" }));
    expect(res.status).toBe(403);
  });

  it("edits a technician and ends their sessions when the role changes", async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 5, first_name: "T", last_name: "E", role: "technician" }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .patch("/api/users/5")
      .set("Authorization", admin())
      .send({ first_name: " Tee ", last_name: "Ech", phone: "0803", role: "user" });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1][1]).toEqual(["Tee", "Ech", "0803", "user", 5]);
    expect(sessionService.invalidateSession).toHaveBeenCalledWith(5);
  });

  it("refuses to promote anyone to admin or edit an admin", async () => {
    db.query.mockResolvedValueOnce([[{ id: 5, first_name: "T", last_name: "E", role: "user" }]]);
    const promote = await request(app)
      .patch("/api/users/5")
      .set("Authorization", admin())
      .send({ first_name: "T", last_name: "E", role: "admin" });
    expect(promote.status).toBe(400);

    db.query.mockResolvedValueOnce([[{ id: 6, role: "admin" }]]);
    const other = await request(app).delete("/api/users/6").set("Authorization", admin());
    expect(other.status).toBe(403);
  });

  it("won't delete an account with history", async () => {
    db.query.mockResolvedValueOnce([[{ id: 5, role: "user" }]]).mockResolvedValueOnce([[{ n: 2 }]]);
    const res = await request(app).delete("/api/users/5").set("Authorization", admin());
    expect(res.status).toBe(409);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("deletes an account with no history", async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 5, role: "user" }]])
      .mockResolvedValueOnce([[{ n: 0 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(app).delete("/api/users/5").set("Authorization", admin());
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2]).toEqual(["DELETE FROM users WHERE id = ?", [5]]);
  });
});

describe("Android app sessions", () => {
  it("gives the Android app the token in the body; browsers never get it", async () => {
    const hashed = await bcrypt.hash("password123", 4);
    const row = [[{ id: 1, email: "ada@example.com", password: hashed, role: "user" }]];

    db.query.mockResolvedValueOnce(row);
    const web = await request(app)
      .post("/api/users/login")
      .set("X-Fixer-Client", "web")
      .send({ email: "ada@example.com", password: "password123" });
    expect(web.body.token).toBeUndefined();

    db.query.mockResolvedValueOnce(row);
    const android = await request(app)
      .post("/api/users/login")
      .set("Origin", "https://localhost")
      .set("X-Fixer-Client", "android")
      .send({ email: "ada@example.com", password: "password123" });
    expect(android.status).toBe(200);
    expect(typeof android.body.token).toBe("string");

    // …and that token works as a Bearer token from the app's origin.
    db.query.mockResolvedValueOnce([[{ id: 1, first_name: "Ada" }]]);
    const me = await request(app)
      .get("/api/users/me")
      .set("Origin", "https://localhost")
      .set("Authorization", `Bearer ${android.body.token}`);
    expect(me.status).toBe(200);
  });

  it("the CSRF guard accepts the Android client header but nothing else", async () => {
    const blocked = await request(app)
      .post("/api/users/login")
      .set("Origin", "https://localhost")
      .set("X-Fixer-Client", "something")
      .send({});
    expect(blocked.status).toBe(403);
  });
});

describe("Android app sessions", () => {
  const jwt = require("jsonwebtoken");

  async function loginAs(client) {
    const hashed = await bcrypt.hash("correct-password", 4);
    db.query.mockResolvedValueOnce([[{ id: 3, email: "ada@example.com", password: hashed, role: "user", token_version: 2 }]]);
    const req = request(app).post("/api/users/login").send({ email: "ada@example.com", password: "correct-password" });
    if (client) req.set("X-Fixer-Client", client);
    return req;
  }

  it("gives the app its token in the body (it can't rely on a cross-site cookie)", async () => {
    const res = await loginAs("android");
    expect(res.status).toBe(200);
    expect(jwt.verify(res.body.token, process.env.JWT_SECRET)).toMatchObject({ id: 3, role: "user", tv: 2 });
  });

  it("never puts the token in the body for browsers", async () => {
    expect((await loginAs("web")).body.token).toBeUndefined();
    expect((await loginAs()).body.token).toBeUndefined();
  });

  it("the app's Bearer token works and a password change hands it a fresh one", async () => {
    const res = await loginAs("android");
    db.query
      .mockResolvedValueOnce([[{ id: 3, first_name: "Ada", email: "ada@example.com", role: "user", token_version: 2, password: await bcrypt.hash("correct-password", 4) }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const change = await request(app)
      .patch("/api/users/me/password")
      .set("Authorization", `Bearer ${res.body.token}`)
      .set("X-Fixer-Client", "android")
      .set("Origin", "https://localhost")
      .send({ current_password: "correct-password", new_password: "brand-new-pass" });
    expect(change.status).toBe(200);
    expect(jwt.decode(change.body.token).tv).toBe(3);
  });

  it("the app passes the CSRF guard from its WebView origin", async () => {
    const res = await request(app)
      .post("/api/users/login")
      .set("Origin", "https://localhost")
      .set("X-Fixer-Client", "android")
      .send({ email: "a@b.co", password: "x" });
    expect(res.status).not.toBe(403);
  });

  it("other client values are still blocked", async () => {
    const res = await request(app)
      .post("/api/users/login")
      .set("Origin", "https://localhost")
      .set("X-Fixer-Client", "evil")
      .send({ email: "a@b.co", password: "x" });
    expect(res.status).toBe(403);
  });
});
