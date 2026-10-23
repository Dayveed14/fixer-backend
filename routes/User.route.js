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
  changePassword,
  getUserById,
  updateUser,
  deleteUser,
} = require("../controllers/User.Controller");
const { verifyToken, authorize } = require("../middleware/auth");
const { loginLimiter, registerLimiter, passwordLimiter } = require("../middleware/rateLimit");

router.post("/register", registerLimiter, registerUser);

router.post("/login", loginLimiter, loginUser);

router.post("/logout", logoutUser);

router.get("/me", verifyToken, getMe);

// Any logged-in role changes their own password.
router.patch("/me/password", verifyToken, passwordLimiter, changePassword);

// Admin-only: provisions technician/staff accounts
router.post("/create", verifyToken, authorize("admin"), createUser);

// Any authenticated user (customers need this to pick a technician when booking)
router.get("/technicians", verifyToken, getTechnicians);

// Full user list with contact info — admin only
router.get("/", verifyToken, authorize("admin"), getUsers);

// Admin: view, edit and delete customer/technician accounts.
router.get("/:id", verifyToken, authorize("admin"), getUserById);
router.patch("/:id", verifyToken, authorize("admin"), updateUser);
router.delete("/:id", verifyToken, authorize("admin"), deleteUser);

module.exports = router;
