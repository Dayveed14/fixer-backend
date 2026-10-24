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

describe("PUT /api/articles/:slug (admin-only)", () => {
  it("403s for a technician", async () => {
    const res = await request(app)
      .put("/api/articles/fix-a-slow-laptop")
      .set("Authorization", authHeader({ role: "technician" }))
      .send({ title: "Updated" });
    expect(res.status).toBe(403);
  });

  it("404s an unknown slug", async () => {
    db.query.mockResolvedValueOnce([[]]); // slug lookup
    const res = await request(app)
      .put("/api/articles/nope")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ title: "Updated" });
    expect(res.status).toBe(404);
  });

  it("200s for an admin, updating by slug without changing the slug (no new file, no cloudinary cleanup)", async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 7, hero_image: "https://img/old.jpg" }]]) // slug lookup
      .mockResolvedValueOnce([{}]); // UPDATE

    const res = await request(app)
      .put("/api/articles/fix-a-slow-laptop")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ title: "Updated", slug: "hijacked-slug", status: "published" });

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][1]).toEqual(["fix-a-slow-laptop"]);
    const [updateSql, updateParams] = db.query.mock.calls[1];
    expect(updateSql).not.toMatch(/slug\s*=/); // the URL slug is permanent
    expect(updateParams).not.toContain("hijacked-slug");
    expect(updateParams[updateParams.length - 1]).toBe(7); // WHERE id = the looked-up id
  });
});

describe("GET article: public vs admin", () => {
  it("public endpoint only returns published articles", async () => {
    const res = await request(app).get("/api/articles/draft-post");
    expect(res.status).toBe(404); // mocked DB returns no published row
    expect(db.query.mock.calls[0][0]).toMatch(/articles\.status = 'published'/);
  });

  it("admin endpoint returns any status", async () => {
    db.query.mockResolvedValueOnce([[{ id: 3, slug: "draft-post", status: "draft" }]]);
    const res = await request(app)
      .get("/api/articles/manage/draft-post")
      .set("Authorization", authHeader({ role: "admin" }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("draft");
    expect(db.query.mock.calls[0][0]).not.toMatch(/'published'/);
  });

  it.each([undefined, "user", "technician"])("admin endpoint is closed to %s", async (role) => {
    const req = request(app).get("/api/articles/manage/draft-post");
    if (role) req.set("Authorization", authHeader({ role }));
    expect((await req).status).toBe(role ? 403 : 401);
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

describe("article/video input hardening", () => {
  const admin = () => authHeader({ id: 7, role: "admin" });

  it("takes the author from the session, never the form", async () => {
    db.query.mockResolvedValueOnce([{ insertId: 1 }]);

    await request(app)
      .post("/api/articles")
      .set("Authorization", admin())
      .field("title", "Battery care")
      .field("author_id", "999");

    const [, params] = db.query.mock.calls[0];
    expect(params[1]).toBe("battery-care"); // slug derived from the title
    expect(params[9]).toBe(7);
  });

  it.each([
    [{ status: "secret" }, /status/],
    [{ title: "" }, /title/],
    [{ slug: "!!!" , title: "!!!" }, /slug/],
  ])("rejects bad fields %#", async (fields, message) => {
    const req = request(app).post("/api/articles").set("Authorization", admin());
    for (const [k, v] of Object.entries({ title: "Ok title", ...fields })) req.field(k, v);
    const res = await req;
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("409s on a duplicate slug", async () => {
    db.query.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" }));
    const res = await request(app)
      .post("/api/articles")
      .set("Authorization", admin())
      .field("title", "Battery care");
    expect(res.status).toBe(409);
  });

  it("refuses SVG uploads (they can carry scripts)", async () => {
    const res = await request(app)
      .post("/api/articles")
      .set("Authorization", admin())
      .field("title", "Battery care")
      .attach("hero_image", Buffer.from("<svg onload=alert(1)>"), { filename: "x.svg", contentType: "image/svg+xml" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/JPG, PNG/);
  });

  it("refuses a file whose extension merely contains an allowed one", async () => {
    const res = await request(app)
      .post("/api/articles")
      .set("Authorization", admin())
      .field("title", "Battery care")
      .attach("hero_image", Buffer.from("MZ"), { filename: "photo.jpg.exe", contentType: "image/jpeg" });
    expect(res.status).toBe(400);
  });

  it("refuses an image on the video endpoint", async () => {
    const res = await request(app)
      .post("/api/diy-videos")
      .set("Authorization", admin())
      .field("title", "Clean your fan")
      .attach("video", Buffer.from("png"), { filename: "x.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/MP4/);
  });
});

describe("editing keeps the URL and featured flag", () => {
  const admin = () => authHeader({ id: 7, role: "admin" });

  it("editing a video without a slug keeps its current slug", async () => {
    db.query
      .mockResolvedValueOnce([[{ slug: "clean-your-fan" }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .put("/api/diy-videos/4")
      .set("Authorization", admin())
      .field("title", "A brand new title")
      .field("status", "published");

    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[1];
    expect(params[1]).toBe("clean-your-fan");
    expect(sql).toMatch(/featured=COALESCE\(\?, featured\)/);
    expect(params[6]).toBeNull(); // featured not sent → unchanged
  });

  it("404s when editing a video that doesn't exist", async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app).put("/api/diy-videos/99").set("Authorization", admin()).field("title", "X title");
    expect(res.status).toBe(404);
  });

  it("editing an article without 'featured' leaves it as it was", async () => {
    db.query.mockResolvedValueOnce([[{ id: 3, hero_image: null }]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    await request(app).put("/api/articles/battery-care").set("Authorization", admin()).field("title", "Battery care");
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/featured = COALESCE\(\?, featured\)/);
    expect(params[5]).toBeNull();
  });
});
