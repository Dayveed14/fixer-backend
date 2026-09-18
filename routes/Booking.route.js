const express = require("express");

const router = express.Router();

const {
  createBooking,
  getBookings,
  getBookingById,
  assignTechnician,
  updateBookingStatus,
  startRemoteSession,
} = require("../controllers/Booking.Controller");
const { paymentFlowLimiter } = require("../middleware/rateLimit");
const { verifyToken, authorize } = require("../middleware/auth");

router.post("/", verifyToken, paymentFlowLimiter, createBooking);

router.get("/", verifyToken, authorize("admin", "technician"), getBookings);

router.get("/:id", verifyToken, getBookingById);

router.patch("/:id/assign", verifyToken, authorize("admin"), assignTechnician);

router.patch(
  "/:id/status",
  verifyToken,
  authorize("admin", "technician"),
  updateBookingStatus,
);

router.post(
  "/:id/remote-session",
  verifyToken,
  authorize("admin", "technician"),
  startRemoteSession,
);

module.exports = router;
