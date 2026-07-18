const express = require("express");

const router = express.Router();

const {
  createBooking,
  getBookings,
  assignTechnician,
  updateBookingStatus,
} = require("../controllers/Booking.Controller");

router.post("/", createBooking);

router.get("/", getBookings);

router.patch("/:id/assign", assignTechnician);

router.patch("/:id/status", updateBookingStatus);

module.exports = router;
