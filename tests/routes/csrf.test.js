const request = require("supertest");
const { app } = require("../helpers/testApp");

// The guard only fires when BOTH a session cookie is present AND the
// method is mutating — Bearer-token requests (no cookie) and GETs are
// never touched by it, which the other route test files already prove
// implicitly (every one of them uses Authorization headers and passes).
// These tests exercise the cookie-specific path directly.

describe("CSRF guard", () => {
  it("blocks a mutating request that carries the session cookie but not the client header", async () => {
    const res = await request(app)
      .post("/api/tickets")
      .set("Cookie", "fixer_token=some.jwt.value")
      .send({ customer_name: "Ada", issue: "x" });

    expect(res.status).toBe(403);
  });

  it("allows it through when the client header is present (still hits normal auth after)", async () => {
    // No valid JWT here, so this should get past the CSRF guard and
    // fail auth instead (401), not get blocked by the guard (403) —
    // proving the guard itself let it through.
    const res = await request(app)
      .post("/api/tickets")
      .set("Cookie", "fixer_token=some.jwt.value")
      .set("X-Fixer-Client", "web")
      .send({ customer_name: "Ada", issue: "x" });

    expect(res.status).not.toBe(403);
  });

  it("never blocks GET requests, even with a cookie and no client header", async () => {
    const res = await request(app)
      .get("/api/users/technicians")
      .set("Cookie", "fixer_token=some.jwt.value");

    // Falls through to normal auth (the cookie's JWT is garbage), not
    // the CSRF guard.
    expect(res.status).not.toBe(403);
  });

  it("never blocks a Bearer-token request with no cookie at all", async () => {
    const res = await request(app).post("/api/tickets").send({});

    // No cookie present, so the guard doesn't apply — falls through to
    // normal auth (401, no token).
    expect(res.status).toBe(401);
  });
});
