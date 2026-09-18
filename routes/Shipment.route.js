const express = require("express");

const router = express.Router();

const shipment = require("../controllers/Shipment.Controller");
const { paymentFlowLimiter } = require("../middleware/rateLimit");

router.post("/", paymentFlowLimiter, shipment.createShipment);

router.get("/", shipment.getShipments);

router.get("/user/:email", shipment.getUserShipment);

router.get("/:id", shipment.getShipment);

router.patch("/:id/status", shipment.updateShipmentStatus);

module.exports = router;
