const express = require("express");

const router = express.Router();

const {
  getDashboardStats,
  getUserStats,
  getTechnicianStats,
} = require("../controllers/Stats.Controller");

router.get("/dashboard", getDashboardStats);

router.get("/user/:userId", getUserStats);

router.get("/technician/:technicianId", getTechnicianStats);

module.exports = router;
