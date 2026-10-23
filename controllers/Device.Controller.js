const db = require("../config/db");
const { parseLimit, textProblem, parseId } = require("../utils/validate");

// Only the device's owner or an admin may change or remove it.
async function loadOwnedDevice(req, res, action) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ message: "Invalid device id." });
    return null;
  }
  const [[device]] = await db.query("SELECT id, customer_id FROM devices WHERE id = ?", [id]);
  if (!device) {
    res.status(404).json({ message: "Device not found." });
    return null;
  }
  if (req.user.role !== "admin" && Number(device.customer_id) !== Number(req.user.id)) {
    res.status(403).json({ message: `You do not have permission to ${action} this device.` });
    return null;
  }
  return device;
}

/* ===========================
   REGISTER DEVICE
=========================== */

exports.createDevice = async (req, res) => {
  try {
    const { device_name, brand, os, serial_number } = req.body || {};
    // Always the caller's own id — a customer can only register a device
    // to their own account. Admins registering on a customer's behalf
    // isn't a supported flow in the frontend today.
    const customer_id = req.user.id;

    const problem = textProblem(req.body, {
      device_name: [120, true],
      brand: [80, false],
      os: [80, false],
      serial_number: [120, false],
    });
    if (problem) {
      return res.status(400).json({ message: problem });
    }

    const sql = `
      INSERT INTO devices
      (
        customer_id,
        device_name,
        brand,
        os,
        serial_number
      )
      VALUES (?, ?, ?, ?, ?)
    `;

    const [result] = await db.query(sql, [
      customer_id,
      device_name,
      brand || null,
      os || null,
      serial_number || null,
    ]);

    return res.status(201).json({
      message: "Device registered",
      id: result.insertId,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   GET DEVICES (by customer)
=========================== */

exports.getDevices = async (req, res) => {
  try {
    // Non-admins only ever see their own devices — token identity wins
    // over whatever customer_id shows up in the query string.
    const customerId =
      req.user.role === "admin"
        ? Number(req.query.customer_id) || null
        : req.user.id;
    const limit = parseLimit(req.query.limit);

    let sql = `
      SELECT
        id,
        customer_id,
        device_name,
        brand,
        os,
        serial_number,
        last_serviced_at,
        created_at
      FROM devices
    `;

    const params = [];

    if (customerId) {
      sql += " WHERE customer_id = ?";
      params.push(customerId);
    }

    sql += " ORDER BY created_at DESC";

    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    const [devices] = await db.query(sql, params);

    return res.json(devices);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   UPDATE LAST SERVICED DATE
=========================== */

exports.updateDeviceService = async (req, res) => {
  try {
    const { last_serviced_at } = req.body || {};

    if (!last_serviced_at || Number.isNaN(Date.parse(last_serviced_at))) {
      return res.status(400).json({ message: "last_serviced_at must be a date." });
    }

    const device = await loadOwnedDevice(req, res, "update");
    if (!device) return undefined;

    await db.query("UPDATE devices SET last_serviced_at = ? WHERE id = ?", [
      new Date(last_serviced_at),
      device.id,
    ]);

    return res.json({
      message: "Device updated",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   DELETE DEVICE
=========================== */

exports.deleteDevice = async (req, res) => {
  try {
    const device = await loadOwnedDevice(req, res, "delete");
    if (!device) return undefined;

    await db.query("DELETE FROM devices WHERE id = ?", [device.id]);

    return res.json({
      message: "Device deleted",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};
