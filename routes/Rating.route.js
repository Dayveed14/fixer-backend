const express = require("express");

const router = express.Router();

const {
  createRating,
  getTechnicianRatings,
} = require("../controllers/Rating.Controller");

router.post("/", createRating);

router.get("/technician/:technicianId", getTechnicianRatings);

module.exports = router;
