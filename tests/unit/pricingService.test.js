// The real pricing engine (route tests use a mock with the defaults).
jest.mock("../../config/db");
const db = require("../../config/db");
const { routeQueries, callsMatching } = require("../helpers/sqlRouter");
const pricing = jest.requireActual("../../services/pricingService");

beforeEach(() => {
  db.__reset();
  pricing.resetPricingCache();
});

describe("reading prices", () => {
  it("falls back to the launch defaults when the tables are empty", async () => {
    expect((await pricing.getSupportType("voice")).amount).toBe(5000);
    expect((await pricing.getDispatchZone("kubwa")).fee).toBe(4500);
    expect((await pricing.getSettings()).delivery_confirm_hours).toBe(12);
  });

  it("falls back to defaults before the migration has run", async () => {
    db.query.mockRejectedValue(Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE" }));
    expect((await pricing.getSupportType("video")).amount).toBe(7000);
  });

  it("uses admin-set prices from the database", async () => {
    routeQueries(db.query, [
      [/FROM pricing_support_types/, [[{ id: "voice", title: "Voice Call", amount: "6000.00" }]]],
      [/FROM dispatch_zones/, [[
        { id: "garki", name: "Garki", group_name: "City centre", distance_km: "5", fee: "2500", active: 1, sort_order: 0 },
        { id: "kuje", name: "Kuje", group_name: "Satellite towns", distance_km: "45", fee: "8000", active: 0, sort_order: 1 },
      ]]],
      [/FROM pricing_settings/, [[
        { setting_key: "delivery_confirm_hours", setting_value: "8" },
        { setting_key: "charge_return_on_decline", setting_value: "0" },
        { setting_key: "unknown_key", setting_value: "1" },
      ]]],
    ]);

    expect((await pricing.getSupportType("voice")).amount).toBe(6000);
    expect((await pricing.getSupportType("video")).amount).toBe(7000); // not overridden
    expect((await pricing.getDispatchZone("garki")).fee).toBe(2500);
    expect(await pricing.getDispatchZone("kubwa")).toBeNull(); // DB list replaces defaults
    expect(await pricing.getDispatchZone("kuje")).toBeNull(); // inactive: not offered…
    expect((await pricing.getZoneById("kuje")).fee).toBe(8000); // …but still known
    const settings = await pricing.getSettings();
    expect(settings.delivery_confirm_hours).toBe(8);
    expect(settings.charge_return_on_decline).toBe(false);
    expect(settings.unknown_key).toBeUndefined();
  });

  it("caches reads and clears the cache on save", async () => {
    await pricing.getPricing();
    await pricing.getPricing();
    expect(db.query).toHaveBeenCalledTimes(3); // one load = 3 queries

    db.query.mockClear();
    // Saving clears the cache, so the fresh prices are reloaded once.
    await pricing.updateSettings({ delivery_confirm_hours: 6 }, 1);
    await pricing.getPricing();
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it("computes fees from the rate card", () => {
    const s = { base_fee: 1000, per_km: 150, min_fee: 1500, round_to: 500 };
    expect(pricing.feeFromRateCard(22, s)).toBe(4500);
    expect(pricing.feeFromRateCard(0, s)).toBe(1500);
  });
});

describe("admin updates", () => {
  const conn = db.mockConnection;

  it("saves call prices in a transaction", async () => {
    await pricing.updateSupportTypes([{ id: "voice", amount: 6000 }, { id: "remote", amount: 12000 }], 1);
    const inserts = callsMatching(conn.query, /INSERT INTO pricing_support_types/);
    expect(inserts.map((c) => c[1])).toEqual([
      ["voice", "Voice Call", 6000, 1],
      ["remote", "Remote Support", 12000, 1],
    ]);
    expect(conn.commit).toHaveBeenCalled();
  });

  it.each([
    [[{ id: "premium", amount: 5000 }], /Unknown support type/],
    [[{ id: "voice", amount: 100 }], /whole number/],
    [[{ id: "voice", amount: 5000.5 }], /whole number/],
    [[], /at least one/],
  ])("rejects bad call prices %j", async (items, message) => {
    await expect(pricing.updateSupportTypes(items, 1)).rejects.toThrow(message);
    expect(conn.beginTransaction).not.toHaveBeenCalled();
  });

  const zone = (o = {}) => ({ id: "garki", name: "Garki", group: "City centre", distanceKm: 5, fee: 2000, active: true, ...o });

  it("upserts zones and deactivates ones left out (never deletes)", async () => {
    await pricing.updateZones([zone(), zone({ id: "new_area", name: "New Area", fee: 3000 })], 1);
    expect(callsMatching(conn.query, /INSERT INTO dispatch_zones/)).toHaveLength(2);
    const [deactivate] = callsMatching(conn.query, /SET active = 0/);
    expect(deactivate[1]).toEqual([1, "garki", "new_area"]);
    expect(callsMatching(conn.query, /DELETE/)).toHaveLength(0);
  });

  it.each([
    [[zone({ id: "Bad Id!" })], /lowercase/],
    [[zone(), zone()], /Duplicate/],
    [[zone({ name: "" })], /needs a name/],
    [[zone({ fee: -1 })], /fee/],
    [[zone({ fee: 2000.5 })], /fee/],
    [[zone({ distanceKm: 500 })], /distance/],
    [[zone({ active: false })], /At least one zone/],
  ])("rejects invalid zones %#", async (zones, message) => {
    await expect(pricing.updateZones(zones, 1)).rejects.toThrow(message);
  });

  it("validates settings", async () => {
    await expect(pricing.updateSettings({ delivery_confirm_hours: 0 }, 1)).rejects.toThrow(/between 1 and 72/);
    await expect(pricing.updateSettings({ charge_return_on_decline: "yes" }, 1)).rejects.toThrow(/true or false/);
    await expect(pricing.updateSettings({ surprise: 1 }, 1)).rejects.toThrow(/Unknown setting/);
    await pricing.updateSettings({ per_km: 200, charge_return_on_decline: false }, 1);
    expect(callsMatching(conn.query, /INSERT INTO pricing_settings/).map((c) => c[1])).toEqual([
      ["per_km", "200", 1],
      ["charge_return_on_decline", "0", 1],
    ]);
  });

  it("rolls back if a write fails", async () => {
    conn.query.mockRejectedValueOnce(new Error("db down"));
    await expect(pricing.updateSupportTypes([{ id: "voice", amount: 6000 }], 1)).rejects.toThrow("db down");
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });
});
