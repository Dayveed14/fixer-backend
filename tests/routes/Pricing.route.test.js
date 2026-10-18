const request = require("supertest");
const { app, db, authHeader } = require("../helpers/testApp");
const pricing = require("../../services/pricingService");

beforeEach(() => db.__reset());

const ADMIN = authHeader({ id: 1, role: "admin" });

describe("/api/pricing (admin pricing page)", () => {
  it.each(["user", "technician"])("403s for a %s", async (role) => {
    const res = await request(app).get("/api/pricing").set("Authorization", authHeader({ role }));
    expect(res.status).toBe(403);
  });

  it("returns call prices, zones and settings", async () => {
    const res = await request(app).get("/api/pricing").set("Authorization", ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.support_types.map((t) => t.id)).toEqual(["voice", "video", "remote"]);
    expect(res.body.zones.length).toBeGreaterThan(10);
    expect(res.body.settings).toHaveProperty("delivery_confirm_hours");
  });

  it("400s validation errors with the reason", async () => {
    const spy = jest.spyOn(pricing, "updateSupportTypes").mockRejectedValueOnce(
      new pricing.PricingValidationError("Voice Call price must be a whole number"),
    );
    const res = await request(app)
      .put("/api/pricing/support-types")
      .set("Authorization", ADMIN)
      .send({ items: [{ id: "voice", amount: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/whole number/);
    spy.mockRestore();
  });

  it("saves zones as the admin", async () => {
    const spy = jest.spyOn(pricing, "updateZones").mockResolvedValueOnce([]);
    const zones = [{ id: "garki", name: "Garki", group: "City centre", distanceKm: 5, fee: 2500 }];
    const res = await request(app).put("/api/pricing/zones").set("Authorization", ADMIN).send({ zones });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(zones, 1);
    spy.mockRestore();
  });

  it("public endpoints serve prices from the engine", async () => {
    pricing.getActiveZones.mockResolvedValueOnce([{ id: "garki", name: "Garki", group: "City centre", distanceKm: 5, fee: 2750, active: true }]);
    const res = await request(app).get("/api/shipments/zones");
    expect(res.body.zones).toEqual([{ id: "garki", name: "Garki", group: "City centre", distanceKm: 5, fee: 2750 }]);
  });
});
