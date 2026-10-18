/* ===========================
   PRICING SERVICE — the pricing engine admins control
   Prices live in three tables, edited from the admin Pricing page:
     pricing_support_types  — Voice / Video / Remote call prices
     dispatch_zones         — Abuja pickup areas and their fees
     pricing_settings       — rate card (base, per km, minimum, rounding),
                              delivery-confirmation window, decline policy
   config/pricing.js holds the launch defaults. They're used whenever a
   table is empty or hasn't been migrated yet, so the app never ends up
   with no prices.

   Reads are cached briefly (prices are read on every payment) and the
   cache is cleared on every admin save.
=========================== */

const db = require("../config/db");
const defaults = require("../config/pricing");

const CACHE_MS = 60 * 1000;

const DEFAULT_SETTINGS = {
  base_fee: defaults.DISPATCH_BASE_FEE,
  per_km: defaults.DISPATCH_PER_KM,
  min_fee: defaults.DISPATCH_MIN_FEE,
  round_to: defaults.DISPATCH_ROUND_TO,
  // Hours the customer has to tap "I've received my device" before the
  // delivery is confirmed automatically.
  delivery_confirm_hours: 12,
  // When a customer declines a repair quote, do they pay the return
  // delivery fee? (Matches the policy shown at checkout.)
  charge_return_on_decline: true,
};

// Validation rules for each setting: [min, max] for numbers.
const SETTING_RULES = {
  base_fee: [0, 100000],
  per_km: [0, 10000],
  min_fee: [0, 100000],
  round_to: [1, 10000],
  delivery_confirm_hours: [1, 72],
};

const LIMITS = {
  supportAmount: [500, 1000000],
  zoneFee: [0, 200000],
  zoneKm: [0, 300],
};

let cache = null;
let cacheAt = 0;

function resetPricingCache() {
  cache = null;
  cacheAt = 0;
}

function defaultSupportTypes() {
  return Object.values(defaults.SUPPORT_TYPES).map((t) => ({ ...t }));
}

function defaultZones() {
  return defaults.DISPATCH_ZONES.map((z, i) => ({
    ...z,
    active: true,
    sort_order: i,
  }));
}

// A missing table (migration not run yet) means "use defaults".
async function safeQuery(sql) {
  try {
    const [rows] = await db.query(sql);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return [];
    throw err;
  }
}

function toBool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

async function loadPricing() {
  const [typeRows, zoneRows, settingRows] = await Promise.all([
    safeQuery("SELECT id, title, amount FROM pricing_support_types"),
    safeQuery(
      "SELECT id, name, group_name, distance_km, fee, active, sort_order FROM dispatch_zones ORDER BY sort_order ASC, distance_km ASC",
    ),
    safeQuery("SELECT setting_key, setting_value FROM pricing_settings"),
  ]);

  // Support types: DB amounts override defaults; the set of types (and
  // how they map to the bookings table) stays fixed in code.
  const supportTypes = defaultSupportTypes().map((t) => {
    const row = typeRows.find((r) => r.id === t.id);
    return row ? { ...t, title: row.title || t.title, amount: Number(row.amount) } : t;
  });

  const zones = zoneRows.length
    ? zoneRows.map((r) => ({
        id: r.id,
        name: r.name,
        group: r.group_name,
        distanceKm: Number(r.distance_km),
        fee: Number(r.fee),
        active: toBool(r.active),
        sort_order: Number(r.sort_order) || 0,
      }))
    : defaultZones();

  const settings = { ...DEFAULT_SETTINGS };
  settingRows.forEach(({ setting_key: key, setting_value: value }) => {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return;
    settings[key] =
      typeof DEFAULT_SETTINGS[key] === "boolean" ? toBool(value) : Number(value);
  });

  return { supportTypes, zones, settings };
}

async function getPricing() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  cache = await loadPricing();
  cacheAt = Date.now();
  return cache;
}

async function getSupportTypes() {
  return (await getPricing()).supportTypes;
}

async function getSupportType(id) {
  if (typeof id !== "string") return null;
  return (await getSupportTypes()).find((t) => t.id === id) || null;
}

/** Active zones only (what customers can pick). */
async function getActiveZones() {
  return (await getPricing()).zones.filter((z) => z.active);
}

/** An active zone by id, or null. */
async function getDispatchZone(id) {
  if (typeof id !== "string") return null;
  return (await getActiveZones()).find((z) => z.id === id) || null;
}

/** Any zone by id, including deactivated ones (for existing shipments). */
async function getZoneById(id) {
  if (typeof id !== "string") return null;
  return (await getPricing()).zones.find((z) => z.id === id) || null;
}

async function getSettings() {
  return (await getPricing()).settings;
}

function feeFromRateCard(km, settings) {
  const raw = settings.base_fee + settings.per_km * km;
  const rounded = Math.ceil(raw / settings.round_to) * settings.round_to;
  return Math.max(settings.min_fee, rounded);
}

/* ---------------------------------------------------------------
   Admin updates — each validates everything first, then writes in
   one transaction, then clears the cache.
--------------------------------------------------------------- */
class PricingValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PricingValidationError";
  }
}

const inRange = (value, [min, max]) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

async function inTransaction(work) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await work(connection);
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
  resetPricingCache();
}

async function updateSupportTypes(items, adminId) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PricingValidationError("Provide at least one support type.");
  }
  const known = defaultSupportTypes();
  const clean = items.map((item) => {
    const base = known.find((t) => t.id === item?.id);
    if (!base) throw new PricingValidationError(`Unknown support type: ${item?.id}`);
    const amount = Number(item.amount);
    if (!inRange(amount, LIMITS.supportAmount) || !Number.isInteger(amount)) {
      throw new PricingValidationError(
        `${base.title} price must be a whole number between ₦${LIMITS.supportAmount[0]} and ₦${LIMITS.supportAmount[1].toLocaleString()}.`,
      );
    }
    return { id: base.id, title: base.title, amount };
  });

  await inTransaction(async (conn) => {
    for (const t of clean) {
      await conn.query(
        `INSERT INTO pricing_support_types (id, title, amount, updated_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE amount = VALUES(amount), title = VALUES(title), updated_by = VALUES(updated_by)`,
        [t.id, t.title, t.amount, adminId],
      );
    }
  });

  return getSupportTypes();
}

const ZONE_ID = /^[a-z0-9_]{2,40}$/;

async function updateZones(zones, adminId) {
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new PricingValidationError("Provide at least one zone.");
  }
  if (zones.length > 200) {
    throw new PricingValidationError("Too many zones.");
  }

  const seen = new Set();
  const clean = zones.map((z, index) => {
    const id = typeof z?.id === "string" ? z.id.trim() : "";
    if (!ZONE_ID.test(id)) {
      throw new PricingValidationError(
        `Zone id "${id}" must be 2–40 lowercase letters, numbers or underscores.`,
      );
    }
    if (seen.has(id)) throw new PricingValidationError(`Duplicate zone id: ${id}`);
    seen.add(id);

    const name = typeof z.name === "string" ? z.name.trim() : "";
    const group = typeof z.group === "string" ? z.group.trim() : "";
    if (!name || name.length > 80) {
      throw new PricingValidationError(`Zone ${id} needs a name (max 80 characters).`);
    }
    if (!group || group.length > 40) {
      throw new PricingValidationError(`Zone ${id} needs a group (max 40 characters).`);
    }

    const distanceKm = Number(z.distanceKm);
    const fee = Number(z.fee);
    if (!inRange(distanceKm, LIMITS.zoneKm)) {
      throw new PricingValidationError(`Zone ${name}: distance must be 0–${LIMITS.zoneKm[1]} km.`);
    }
    if (!inRange(fee, LIMITS.zoneFee) || !Number.isInteger(fee)) {
      throw new PricingValidationError(
        `Zone ${name}: fee must be a whole number up to ₦${LIMITS.zoneFee[1].toLocaleString()}.`,
      );
    }

    return {
      id,
      name,
      group,
      distanceKm,
      fee,
      active: z.active === undefined ? true : Boolean(z.active),
      sort_order: index,
    };
  });

  if (!clean.some((z) => z.active)) {
    throw new PricingValidationError("At least one zone must stay active.");
  }

  await inTransaction(async (conn) => {
    for (const z of clean) {
      await conn.query(
        `INSERT INTO dispatch_zones (id, name, group_name, distance_km, fee, active, sort_order, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name), group_name = VALUES(group_name),
           distance_km = VALUES(distance_km), fee = VALUES(fee),
           active = VALUES(active), sort_order = VALUES(sort_order),
           updated_by = VALUES(updated_by)`,
        [z.id, z.name, z.group, z.distanceKm, z.fee, z.active ? 1 : 0, z.sort_order, adminId],
      );
    }
    // Zones missing from the list are deactivated, never deleted —
    // existing shipments still reference them.
    const ids = clean.map((z) => z.id);
    await conn.query(
      `UPDATE dispatch_zones SET active = 0, updated_by = ? WHERE id NOT IN (${ids.map(() => "?").join(",")})`,
      [adminId, ...ids],
    );
  });

  return (await getPricing()).zones;
}

async function updateSettings(input, adminId) {
  if (!input || typeof input !== "object") {
    throw new PricingValidationError("Provide the settings to update.");
  }

  const entries = [];
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
      throw new PricingValidationError(`Unknown setting: ${key}`);
    }
    if (typeof DEFAULT_SETTINGS[key] === "boolean") {
      if (typeof value !== "boolean") {
        throw new PricingValidationError(`${key} must be true or false.`);
      }
      entries.push([key, value ? "1" : "0"]);
    } else {
      const number = Number(value);
      if (!inRange(number, SETTING_RULES[key])) {
        const [min, max] = SETTING_RULES[key];
        throw new PricingValidationError(`${key} must be between ${min} and ${max}.`);
      }
      entries.push([key, String(number)]);
    }
  }

  if (!entries.length) throw new PricingValidationError("Nothing to update.");

  await inTransaction(async (conn) => {
    for (const [key, value] of entries) {
      await conn.query(
        `INSERT INTO pricing_settings (setting_key, setting_value, updated_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
        [key, value, adminId],
      );
    }
  });

  return getSettings();
}

module.exports = {
  DEFAULT_SETTINGS,
  LIMITS,
  PricingValidationError,
  getPricing,
  getSupportTypes,
  getSupportType,
  getActiveZones,
  getDispatchZone,
  getZoneById,
  getSettings,
  feeFromRateCard,
  updateSupportTypes,
  updateZones,
  updateSettings,
  resetPricingCache,
};
