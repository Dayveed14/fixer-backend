// Route tests run against the launch defaults in config/pricing.js so
// they don't depend on the pricing tables or the in-memory cache. The
// real engine is tested directly in tests/unit/pricingService.test.js.
const defaults = require("../../config/pricing");
const actual = jest.requireActual("../pricingService");

const supportTypes = () => Object.values(defaults.SUPPORT_TYPES).map((t) => ({ ...t }));
const zones = () => defaults.DISPATCH_ZONES.map((z, i) => ({ ...z, active: true, sort_order: i }));

const settings = { ...actual.DEFAULT_SETTINGS };

module.exports = {
  ...actual,
  __settings: settings,
  getPricing: jest.fn(async () => ({ supportTypes: supportTypes(), zones: zones(), settings: { ...settings } })),
  getSupportTypes: jest.fn(async () => supportTypes()),
  getSupportType: jest.fn(async (id) => supportTypes().find((t) => t.id === id) || null),
  getActiveZones: jest.fn(async () => zones()),
  getDispatchZone: jest.fn(async (id) => zones().find((z) => z.id === id) || null),
  getZoneById: jest.fn(async (id) => zones().find((z) => z.id === id) || null),
  getSettings: jest.fn(async () => ({ ...settings })),
};
