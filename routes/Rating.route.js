const express = require("express");

const router = express.Router();

const {
  createRating,
  getTechnicianRatings,
} = require("../controllers/Rating.Controller");
const { verifyToken, authorize } = require("../middleware/auth");

router.post("/", verifyToken, authorize("user"), createRating);

// Public: shown on technician profile cards
router.get("/technician/:technicianId", getTechnicianRatings);

module.exports = router;
