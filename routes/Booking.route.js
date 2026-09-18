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

// Open to any authenticated role — a customer uses this for their own
// dashboard (?user_id=me), a technician for their own queue, and an
// admin for everything. The role-based scoping/ownership enforcement
// happens inside the controller, not here.
router.get("/", verifyToken, getBookings);

router.get("/:id", verifyToken, getBookingById);

router.patch("/:id/assign", verifyToken, authorize("admin"), assignTechnician);

// Open to any authenticated role — customers cancel their own booking
// through this same endpoint. Fine-grained rules (who can set what,
// on which booking) are enforced inside the controller.
router.patch("/:id/status", verifyToken, updateBookingStatus);

router.post(
  "/:id/remote-session",
  verifyToken,
  authorize("admin", "technician"),
  startRemoteSession,
);

module.exports = router;
