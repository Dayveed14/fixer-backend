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

router.post("/", createBooking);

router.get("/", getBookings);

router.get("/:id", getBookingById);

router.patch("/:id/assign", assignTechnician);

router.patch("/:id/status", updateBookingStatus);

router.post("/:id/remote-session", startRemoteSession);

module.exports = router;
