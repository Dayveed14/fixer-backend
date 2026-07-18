const express = require("express");

const router = express.Router();

const {
  createDevice,
  getDevices,
  updateDeviceService,
  deleteDevice,
} = require("../controllers/Device.Controller");

router.post("/", createDevice);

router.get("/", getDevices);

router.patch("/:id/service", updateDeviceService);

router.delete("/:id", deleteDevice);

module.exports = router;
