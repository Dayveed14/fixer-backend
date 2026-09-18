const express = require("express");

const router = express.Router();

const shipment = require("../controllers/Shipment.Controller");
const { paymentFlowLimiter } = require("../middleware/rateLimit");
const { verifyToken, authorize } = require("../middleware/auth");

router.post("/", verifyToken, paymentFlowLimiter, shipment.createShipment);

router.get("/", verifyToken, authorize("admin"), shipment.getShipments);

router.get("/user/:email", verifyToken, shipment.getUserShipment);

router.get("/:id", verifyToken, shipment.getShipment);

router.patch(
  "/:id/status",
  verifyToken,
  authorize("admin", "technician"),
  shipment.updateShipmentStatus,
);

module.exports = router;
