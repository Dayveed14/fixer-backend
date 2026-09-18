const express = require("express");

const router = express.Router();

const {
  getDashboardStats,
  getUserStats,
  getTechnicianStats,
} = require("../controllers/Stats.Controller");
const { verifyToken, authorize } = require("../middleware/auth");

router.get("/dashboard", verifyToken, authorize("admin"), getDashboardStats);

router.get("/user/:userId", verifyToken, getUserStats);

router.get(
  "/technician/:technicianId",
  verifyToken,
  authorize("admin", "technician"),
  getTechnicianStats,
);

module.exports = router;
