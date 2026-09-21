const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");

beforeEach(() => {
  db.__reset();
});

describe("POST /api/diy-videos (admin-only)", () => {
  it("401s with no token", async () => {
    const res = await request(app).post("/api/diy-videos").send({ title: "x" });
    expect(res.status).toBe(401);
  });

  it("403s for a customer", async () => {
    const res = await request(app)
      .post("/api/diy-videos")
      .set("Authorization", authHeader({ role: "user" }))
      .send({ title: "x" });
    expect(res.status).toBe(403);
  });

  it("400s an admin submission with no video file attached", async () => {
    const res = await request(app)
      .post("/api/diy-videos")
      .set("Authorization", authHeader({ role: "admin" }))
      .field("title", "How to replace a battery");

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/video file is required/i);
  });
});

describe("GET /api/diy-videos/published (public)", () => {
  it("200s with no auth", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, title: "Battery swap" }]]);

    const res = await request(app).get("/api/diy-videos/published");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("GET /api/diy-videos (admin-only, includes drafts)", () => {
  it("403s for a technician", async () => {
    const res = await request(app)
      .get("/api/diy-videos")
      .set("Authorization", authHeader({ role: "technician" }));
    expect(res.status).toBe(403);
  });

  it("200s for an admin", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1 }]]);

    const res = await request(app)
      .get("/api/diy-videos")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
  });
});

describe("GET /api/diy-videos/:id (public)", () => {
  it("404s an unknown video", async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app).get("/api/diy-videos/999");

    expect(res.status).toBe(404);
  });

  it("200s a known video with no auth required", async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, title: "Battery swap" }]]);

    const res = await request(app).get("/api/diy-videos/1");

    expect(res.status).toBe(200);
  });
});

describe("PUT /api/diy-videos/:id (admin-only)", () => {
  it("403s for a customer", async () => {
    const res = await request(app)
      .put("/api/diy-videos/1")
      .set("Authorization", authHeader({ role: "user" }))
      .send({ title: "Updated" });
    expect(res.status).toBe(403);
  });

  it("200s for an admin with no new file (no cloudinary cleanup triggered)", async () => {
    db.query.mockResolvedValueOnce([{}]);

    const res = await request(app)
      .put("/api/diy-videos/1")
      .set("Authorization", authHeader({ role: "admin" }))
      .send({ title: "Updated", status: "published" });

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/diy-videos/:id (admin-only)", () => {
  it("403s for a technician", async () => {
    const res = await request(app)
      .delete("/api/diy-videos/1")
      .set("Authorization", authHeader({ role: "technician" }));
    expect(res.status).toBe(403);
  });

  it("200s for an admin", async () => {
    db.query
      .mockResolvedValueOnce([[{ video_url: null }]])
      .mockResolvedValueOnce([{}]);

    const res = await request(app)
      .delete("/api/diy-videos/1")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
  });
});
