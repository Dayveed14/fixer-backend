const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");

beforeEach(() => {
  db.__reset();
});

describe("POST /api/articles (admin-only)", () => {
  it("401s with no token", async () => {
    const res = await request(app).post("/api/articles").send({ title: "x" });
    expect(res.status).toBe(401);
  });

  it("403s for a technician", async () => {
    const res = await request(app)
      .post("/api/articles")
      .set("Authorization", authHeader({ role: "technician" }))
      .send({ title: "x" });
    expect(res.status).toBe(403);
  });

  it("creates an article for an admin", async () => {
    db.query.mockResolvedValueOnce([{ insertId: 1 }]);

    const res = await request(app)
      .post("/api/articles")
      .set("Authorization", authHeader({ role: "admin" }))
      .field("title", "How to fix a cracked screen")
      .field("slug", "cracked-screen")
      .field("status", "draft");

    expect(res.status).toBe(201);
  });
});

describe("GET /api/articles/published (public)", () => {
  it("200s with no auth", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, title: "Published post" }]]);

    const res = await request(app).get("/api/articles/published");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("GET /api/articles (admin-only, includes drafts)", () => {
  it("403s for a customer", async () => {
    const res = await request(app)
      .get("/api/articles")
      .set("Authorization", authHeader({ role: "user" }));
    expect(res.status).toBe(403);
  });

  it("200s for an admin", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]]);

    const res = await request(app)
      .get("/api/articles")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
  });
});

describe("GET /api/articles/:id (public)", () => {
  it("404s an unknown article", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app).get("/api/articles/999");

    expect(res.status).toBe(404);
  });

  it("200s a known article with no auth required", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, title: "Post" }]]);

    const res = await request(app).get("/api/articles/1");

    expect(res.status).toBe(200);
  });
});

describe("PUT /api/articles/:id (admin-only)", () => {
  it("403s for a technician", async () => {
    const res = await request(app)
      .put("/api/articles/1")
      .set("Authorization", authHeader({ role: "technician" }))
      .send({ title: "Updated" });
    expect(res.status).toBe(403);
  });

  it("200s for an admin (no new file, no cloudinary cleanup)", async () => {
    db.query.mockResolvedValueOnce([{}]);

    const res = await request(app)
      .put("/api/articles/1")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ title: "Updated", status: "published" });

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(1); // no old-image lookup without a new file
  });
});

describe("DELETE /api/articles/:id (admin-only)", () => {
  it("403s for a customer", async () => {
    const res = await request(app)
      .delete("/api/articles/1")
      .set("Authorization", authHeader({ role: "user" }));
    expect(res.status).toBe(403);
  });

  it("200s for an admin", async () => {
    db.query
      .mockResolvedValueOnce([[{ hero_image: null }]])
      .mockResolvedValueOnce([{}]);

    const res = await request(app)
      .delete("/api/articles/1")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
  });
});
