/* ===========================
   PRICING — single source of truth
   Every amount a customer can be charged is defined here, server-side.
   The frontend reads dispatch zones from GET /api/shipments/zones and
   support prices from GET /api/bookings/support-types, and the payment
   amount is always computed here when a payment is initialised — the
   client never decides what it pays.
=========================== */

// ---------------------------------------------------------------
// Remote support (BookCall)
// Frontend uses "remote" as the id; DB enum uses "remote_desktop".
// ---------------------------------------------------------------
const SUPPORT_TYPES = {
  voice: { id: "voice", db: "voice", title: "Voice Call", amount: 5000 },
  video: { id: "video", db: "video", title: "Video Call", amount: 7000 },
  remote: {
    id: "remote",
    db: "remote_desktop",
    title: "Remote Support",
    amount: 10000,
  },
};

// ---------------------------------------------------------------
// Device pickup (dispatch) — Abuja zones
//
// The repair office is in Wuse, so the fee depends on how far the
// rider has to travel to collect the device. Fees follow a simple,
// explainable rate card in line with what Abuja bike dispatch services
// typically charge for intra-city runs (roughly ₦1,500 inside the
// city centre up to ₦4,000–₦5,000 for outer suburbs):
//
//   fee = ₦1,000 base + ₦150 per km (approx. road distance to Wuse),
//         rounded UP to the nearest ₦500, minimum ₦1,500.
//
// The computed fee is stored per zone below (rather than calculated
// at request time) so it is easy to read, and so an admin can override
// an individual zone without touching the formula. Distances are
// approximate road distances from Wuse, not straight-line.
// ---------------------------------------------------------------
const DISPATCH_BASE_FEE = 1000;
const DISPATCH_PER_KM = 150;
const DISPATCH_ROUND_TO = 500;
const DISPATCH_MIN_FEE = 1500;

function feeForDistance(km) {
  const raw = DISPATCH_BASE_FEE + DISPATCH_PER_KM * km;
  const rounded = Math.ceil(raw / DISPATCH_ROUND_TO) * DISPATCH_ROUND_TO;
  return Math.max(DISPATCH_MIN_FEE, rounded);
}

// [id, display name, approx km to Wuse, group]
const RAW_ZONES = [
  // City centre
  ["wuse", "Wuse (Zones 1–7) / Wuse 2", 2, "City centre"],
  ["cbd", "Central Business District", 3, "City centre"],
  ["maitama", "Maitama", 4, "City centre"],
  ["utako", "Utako / Jabi", 5, "City centre"],
  ["garki", "Garki (Areas 1–11)", 5, "City centre"],
  ["wuye", "Wuye", 5, "City centre"],
  ["mabushi", "Mabushi / Katampe", 7, "City centre"],
  ["asokoro", "Asokoro", 8, "City centre"],
  // Inner districts
  ["kado", "Kado", 8, "Inner districts"],
  ["jahi", "Jahi", 9, "Inner districts"],
  ["durumi", "Durumi", 9, "Inner districts"],
  ["gudu", "Gudu", 10, "Inner districts"],
  ["life_camp", "Life Camp", 11, "Inner districts"],
  ["karmo", "Karmo", 12, "Inner districts"],
  ["apo", "Apo", 13, "Inner districts"],
  ["galadimawa", "Galadimawa", 14, "Inner districts"],
  ["gwarinpa", "Gwarinpa", 15, "Inner districts"],
  ["lokogoma", "Lokogoma", 15, "Inner districts"],
  ["idu", "Idu", 15, "Inner districts"],
  // Satellite towns
  ["dawaki", "Dawaki", 17, "Satellite towns"],
  ["karu", "Karu", 17, "Satellite towns"],
  ["lugbe", "Lugbe", 18, "Satellite towns"],
  ["dutse", "Dutse", 18, "Satellite towns"],
  ["nyanya", "Nyanya", 20, "Satellite towns"],
  ["kubwa", "Kubwa", 22, "Satellite towns"],
  ["mararaba", "Mararaba", 24, "Satellite towns"],
  ["bwari", "Bwari", 38, "Satellite towns"],
  ["kuje", "Kuje", 45, "Satellite towns"],
  ["gwagwalada", "Gwagwalada", 50, "Satellite towns"],
];

const DISPATCH_ZONES = RAW_ZONES.map(([id, name, distanceKm, group]) => ({
  id,
  name,
  group,
  distanceKm,
  fee: feeForDistance(distanceKm),
}));

const DISPATCH_ZONE_MAP = Object.fromEntries(
  DISPATCH_ZONES.map((zone) => [zone.id, zone]),
);

function getDispatchZone(zoneId) {
  if (typeof zoneId !== "string") return null;
  return Object.hasOwn(DISPATCH_ZONE_MAP, zoneId) ? DISPATCH_ZONE_MAP[zoneId] : null;
}

function getSupportType(typeId) {
  if (typeof typeId !== "string") return null;
  return Object.hasOwn(SUPPORT_TYPES, typeId) ? SUPPORT_TYPES[typeId] : null;
}

const toKobo = (naira) => Math.round(naira * 100);

module.exports = {
  SUPPORT_TYPES,
  DISPATCH_ZONES,
  DISPATCH_BASE_FEE,
  DISPATCH_PER_KM,
  DISPATCH_ROUND_TO,
  DISPATCH_MIN_FEE,
  REPAIR_OFFICE: "Wuse, Abuja",
  feeForDistance,
  getDispatchZone,
  getSupportType,
  toKobo,
};
