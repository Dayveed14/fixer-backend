const express = require("express");

const router = express.Router();

const shipment = require("../controllers/Shipment.Controller");
const { paymentFlowLimiter } = require("../middleware/rateLimit");
const { verifyToken, authorize } = require("../middleware/auth");

// Public: the pickup wizard's area/price list and time-slot picker.
router.get("/zones", shipment.getZones);
router.get("/slots", shipment.getPickupSlots);

router.post("/", verifyToken, paymentFlowLimiter, shipment.createShipment);

router.get("/", verifyToken, authorize("admin"), shipment.getShipments);

router.get("/user/:email", verifyToken, shipment.getUserShipment);

// Technician: repairs assigned to me, and report the result.
// ("/assigned" must come before "/:id".)
router.get(
  "/assigned",
  verifyToken,
  authorize("admin", "technician"),
  shipment.getAssignedRepairs,
);
router.post(
  "/:id/repair-result",
  verifyToken,
  authorize("admin", "technician"),
  shipment.reportRepairResult,
);

router.get("/:id", verifyToken, shipment.getShipment);

// Customer: answer the repair quote, confirm the device came back.
router.post("/:id/approval", verifyToken, paymentFlowLimiter, shipment.respondToQuote);
router.post("/:id/confirm-delivery", verifyToken, shipment.confirmDelivery);

// Admin: send the diagnosis + quote.
router.post("/:id/quote", verifyToken, authorize("admin"), shipment.sendQuote);

// Admin moves the shipment along (technicians report repairs via
// /repair-result instead).
router.patch(
  "/:id/status",
  verifyToken,
  authorize("admin"),
  shipment.updateShipmentStatus,
);

module.exports = router;
