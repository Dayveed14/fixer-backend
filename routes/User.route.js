const express = require("express");

const router = express.Router();

const {
  registerUser,
  loginUser,
  createUser,
  getTechnicians,
  getUsers,
} = require("../controllers/User.Controller");
const { verifyToken, authorize } = require("../middleware/auth");

router.post("/register", registerUser);

router.post("/login", loginUser);

// Admin-only: provisions technician/staff accounts
router.post("/create", verifyToken, authorize("admin"), createUser);

// Any authenticated user (customers need this to pick a technician when booking)
router.get("/technicians", verifyToken, getTechnicians);

// Full user list with contact info — admin only
router.get("/", verifyToken, authorize("admin"), getUsers);

module.exports = router;
