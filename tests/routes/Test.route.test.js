const request = require("supertest");
const { app, authHeader } = require("../helpers/testApp");
const { generateInviteLink } = require("../../services/meshCentralService");

beforeEach(() => {
  generateInviteLink.mockClear();
});

describe("GET /api/test/mesh/test (admin-only)", () => {
  it("401s with no token", async () => {
    const res = await request(app).get("/api/test/mesh/test");
    expect(res.status).toBe(401);
  });

  it("403s for a non-admin — this leaks MeshCentral invite links, must stay locked down", async () => {
    const res = await request(app)
      .get("/api/test/mesh/test")
      .set("Authorization", authHeader({ role: "technician" }));
    expect(res.status).toBe(403);
  });

  it("200s for an admin", async () => {
    const res = await request(app)
      .get("/api/test/mesh/test")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(generateInviteLink).toHaveBeenCalled();
  });

  it("500s cleanly if MeshCentral invite generation fails", async () => {
    generateInviteLink.mockRejectedValueOnce(new Error("meshctrl unreachable"));

    const res = await request(app)
      .get("/api/test/mesh/test")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
