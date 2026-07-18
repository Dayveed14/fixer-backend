const express = require("express");

const router = express.Router();

const {
  registerUser,
  loginUser,
  createUser,
  getTechnicians,
  getUsers,
} = require("../controllers/User.Controller");

router.post("/register", registerUser);

router.post("/login", loginUser);

router.post("/create", createUser);

router.get("/technicians", getTechnicians);

router.get("/", getUsers);

module.exports = router;
