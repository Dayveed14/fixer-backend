const express = require("express");

const router = express.Router();

const {
  registerUser,
  loginUser,
  logoutUser,
  getMe,
  createUser,
  getTechnicians,
  getUsers,
} = require("../controllers/User.Controller");
const { verifyToken, authorize } = require("../middleware/auth");
const { loginLimiter } = require("../middleware/rateLimit");

router.post("/register", registerUser);

router.post("/login", loginLimiter, loginUser);

router.post("/logout", logoutUser);

router.get("/me", verifyToken, getMe);

// Admin-only: provisions technician/staff accounts
router.post("/create", verifyToken, authorize("admin"), createUser);

// Any authenticated user (customers need this to pick a technician when booking)
router.get("/technicians", verifyToken, getTechnicians);

// Full user list with contact info — admin only
router.get("/", verifyToken, authorize("admin"), getUsers);

module.exports = router;
