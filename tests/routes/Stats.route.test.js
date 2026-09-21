const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");

beforeEach(() => {
  db.__reset();
});

describe("GET /api/stats/dashboard (admin-only)", () => {
  it("401s with no token", async () => {
    const res = await request(app).get("/api/stats/dashboard");
    expect(res.status).toBe(401);
  });

  it("403s for a technician", async () => {
    const res = await request(app)
      .get("/api/stats/dashboard")
      .set("Authorization", authHeader({ role: "technician" }));
    expect(res.status).toBe(403);
  });

  it("200s for an admin", async () => {
    db.query
      .mockResolvedValueOnce([[{ totalUsers: 10 }]])
      .mockResolvedValueOnce([[{ totalTechnicians: 3 }]])
      .mockResolvedValueOnce([[{ openTickets: 4 }]])
      .mockResolvedValueOnce([[{ totalDevices: 20 }]])
      .mockResolvedValueOnce([[{ unassignedCalls: 1 }]])
      .mockResolvedValueOnce([[{ currentMonthRevenue: 50000 }]])
      .mockResolvedValueOnce([[{ lastMonthRevenue: 40000 }]]);

    const res = await request(app)
      .get("/api/stats/dashboard")
      .set("Authorization", authHeader({ role: "admin" }));

    expect(res.status).toBe(200);
    expect(res.body.totalUsers).toBe(10);
    expect(res.body.revenueChangePercent).toBe(25);
  });
});

describe("GET /api/stats/user/:userId", () => {
  it("403s a customer requesting someone else's stats", async () => {
    const res = await request(app)
      .get("/api/stats/user/999")
      .set("Authorization", authHeader({ id: 3, role: "user" }));
    expect(res.status).toBe(403);
  });

  it("200s for the caller's own stats", async () => {
    db.query
      .mockResolvedValueOnce([[{ repairsInProgress: 1 }]])
      .mockResolvedValueOnce([[{ aiDiagnoses: 2 }]])
      .mockResolvedValueOnce([[{ appointmentsCount: 1 }]])
      .mockResolvedValueOnce([[{ registeredDevices: 3 }]]);

    const res = await request(app)
      .get("/api/stats/user/3")
      .set("Authorization", authHeader({ id: 3, role: "user" }));

    expect(res.status).toBe(200);
    expect(res.body.registeredDevices).toBe(3);
  });
});

describe("GET /api/stats/technician/:technicianId", () => {
  it("403s a technician requesting someone else's stats", async () => {
    const res = await request(app)
      .get("/api/stats/technician/999")
      .set("Authorization", authHeader({ id: 7, role: "technician" }));
    expect(res.status).toBe(403);
  });

  it("200s for the caller's own stats", async () => {
    db.query
      .mockResolvedValueOnce([[{ assignedJobs: 5 }]])
      .mockResolvedValueOnce([[{ completedToday: 1 }]])
      .mockResolvedValueOnce([[{ pendingRepairs: 2 }]])
      .mockResolvedValueOnce([[{ devicesRepaired: 3 }]])
      .mockResolvedValueOnce([[{ avgRating: 4.5, ratingCount: 6 }]]);

    const res = await request(app)
      .get("/api/stats/technician/7")
      .set("Authorization", authHeader({ id: 7, role: "technician" }));

    expect(res.status).toBe(200);
    expect(res.body.performancePercent).toBe(90);
  });
});
