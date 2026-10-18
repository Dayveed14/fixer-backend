const express = require("express");
const pricing = require("../controllers/Pricing.Controller");
const { verifyToken, authorize } = require("../middleware/auth");

const router = express.Router();

// Admin-only: the Pricing page in the admin dashboard.
router.use(verifyToken, authorize("admin"));

router.get("/", pricing.getPricing);
router.put("/support-types", pricing.updateSupportTypes);
router.put("/zones", pricing.updateZones);
router.put("/settings", pricing.updateSettings);

module.exports = router;
