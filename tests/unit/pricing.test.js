const {
  DISPATCH_ZONES,
  feeForDistance,
  getDispatchZone,
  getSupportType,
} = require("../../config/pricing");

describe("dispatch rate card (₦1,000 + ₦150/km, rounded up to ₦500, min ₦1,500)", () => {
  it.each([
    [0, 1500],
    [2, 1500],
    [5, 2000],
    [15, 3500],
    [18, 4000],
    [22, 4500],
    [50, 8500],
  ])("%i km -> ₦%i", (km, fee) => {
    expect(feeForDistance(km)).toBe(fee);
  });
});

describe("Abuja zones", () => {
  it("prices Garki, Lugbe and Kubwa to Wuse differently", () => {
    expect(getDispatchZone("garki").fee).toBe(2000);
    expect(getDispatchZone("lugbe").fee).toBe(4000);
    expect(getDispatchZone("kubwa").fee).toBe(4500);
  });

  it("charges more the further the area is from Wuse", () => {
    const sorted = [...DISPATCH_ZONES].sort((a, b) => a.distanceKm - b.distanceKm);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].fee).toBeGreaterThanOrEqual(sorted[i - 1].fee);
    }
  });

  it("has unique ids and whole-naira fees", () => {
    const ids = DISPATCH_ZONES.map((z) => z.id);
    expect(new Set(ids).size).toBe(ids.length);
    DISPATCH_ZONES.forEach((z) => expect(Number.isInteger(z.fee)).toBe(true));
  });

  it("rejects unknown or non-string zones", () => {
    expect(getDispatchZone("lagos")).toBeNull();
    expect(getDispatchZone({ id: "garki" })).toBeNull();
    expect(getDispatchZone("__proto__")).toBeNull();
  });
});

describe("support types", () => {
  it("prices calls server-side", () => {
    expect(getSupportType("voice").amount).toBe(5000);
    expect(getSupportType("remote").db).toBe("remote_desktop");
    expect(getSupportType("constructor")).toBeNull();
  });
});
