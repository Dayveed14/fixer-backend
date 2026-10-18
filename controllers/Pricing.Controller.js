const pricing = require("../services/pricingService");

function handle(res, err, label) {
  if (err.name === "PricingValidationError") {
    return res.status(400).json({ message: err.message });
  }
  console.error(label, err);
  return res.status(500).json({ message: "Internal Server Error" });
}

/* GET /api/pricing (admin) — everything the Pricing page edits. */
exports.getPricing = async (req, res) => {
  try {
    const { supportTypes, zones, settings } = await pricing.getPricing();
    return res.json({
      support_types: supportTypes.map(({ id, title, amount }) => ({ id, title, amount })),
      zones,
      settings,
      limits: pricing.LIMITS,
    });
  } catch (err) {
    return handle(res, err, "Get pricing error:");
  }
};

/* PUT /api/pricing/support-types  { items: [{ id, amount }] } */
exports.updateSupportTypes = async (req, res) => {
  try {
    const types = await pricing.updateSupportTypes(req.body?.items, req.user.id);
    return res.json({ message: "Call prices updated", support_types: types });
  } catch (err) {
    return handle(res, err, "Update support types error:");
  }
};

/* PUT /api/pricing/zones  { zones: [{ id, name, group, distanceKm, fee, active }] } */
exports.updateZones = async (req, res) => {
  try {
    const zones = await pricing.updateZones(req.body?.zones, req.user.id);
    return res.json({ message: "Pickup areas updated", zones });
  } catch (err) {
    return handle(res, err, "Update zones error:");
  }
};

/* PUT /api/pricing/settings  { base_fee, per_km, ..., charge_return_on_decline } */
exports.updateSettings = async (req, res) => {
  try {
    const settings = await pricing.updateSettings(req.body, req.user.id);
    return res.json({ message: "Settings updated", settings });
  } catch (err) {
    return handle(res, err, "Update pricing settings error:");
  }
};
