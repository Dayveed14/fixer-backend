const express = require("express");

const router = express.Router();

const {
  createDevice,
  getDevices,
  updateDeviceService,
  deleteDevice,
} = require("../controllers/Device.Controller");
const { verifyToken } = require("../middleware/auth");

router.post("/", verifyToken, createDevice);

router.get("/", verifyToken, getDevices);

router.patch("/:id/service", verifyToken, updateDeviceService);

router.delete("/:id", verifyToken, deleteDevice);

module.exports = router;
