const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");

beforeEach(() => {
  db.__reset();
});

describe("GET /api/notifications", () => {
  it("401s with no token", async () => {
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(401);
  });

  it("scopes the query to the caller's own id/role, ignoring any query params", async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 1, title: "Hi" }]])
      .mockResolvedValueOnce([[{ unread: 1 }]]);

    const res = await request(app)
      .get("/api/notifications?user_id=999&role=admin")
      .set("Authorization", authHeader({ id: 3, role: "user", email: "ada@x.com" }));

    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(1);
    const [, params] = db.query.mock.calls[0];
    expect(params).toEqual([3, "user", 20]);
  });
});

describe("PATCH /api/notifications/:id/read", () => {
  it("404s when the notification isn't the caller's", async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

    const res = await request(app)
      .patch("/api/notifications/1/read")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(404);
  });

  it("200s when it belongs to the caller", async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .patch("/api/notifications/1/read")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/notifications/read-all", () => {
  it("401s with no token", async () => {
    const res = await request(app).patch("/api/notifications/read-all");
    expect(res.status).toBe(401);
  });

  it("200s and scopes the update to the caller", async () => {
    db.query.mockResolvedValueOnce([{}]);

    const res = await request(app)
      .patch("/api/notifications/read-all")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(200);
    const [, params] = db.query.mock.calls[0];
    expect(params).toEqual([3, "user"]);
  });
});
