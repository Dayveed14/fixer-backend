const db = require("../config/db");

/* ===========================
   REGISTER DEVICE
=========================== */

exports.createDevice = async (req, res) => {
  try {
    const { device_name, brand, os, serial_number } = req.body;
    // Always the caller's own id — a customer can only register a device
    // to their own account. Admins registering on a customer's behalf
    // isn't a supported flow in the frontend today.
    const customer_id = req.user.id;

    if (!device_name) {
      return res.status(400).json({
        message: "device_name is required.",
      });
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
    const limit = Number(req.query.limit) || null;

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
    const { id } = req.params;
    const { last_serviced_at } = req.body;

    // Only the owning customer (or an admin/technician doing the
    // servicing) may touch this record.
    if (req.user.role === "user") {
      const [[device]] = await db.query(
        "SELECT customer_id FROM devices WHERE id = ?",
        [id],
      );

      if (!device) {
        return res.status(404).json({ message: "Device not found." });
      }

      if (device.customer_id !== req.user.id) {
        return res.status(403).json({
          message: "You do not have permission to update this device.",
        });
      }
    }

    await db.query("UPDATE devices SET last_serviced_at = ? WHERE id = ?", [
      last_serviced_at,
      id,
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
    const { id } = req.params;

    // Same rule as above: customers may only delete their own devices.
    if (req.user.role === "user") {
      const [[device]] = await db.query(
        "SELECT customer_id FROM devices WHERE id = ?",
        [id],
      );

      if (!device) {
        return res.status(404).json({ message: "Device not found." });
      }

      if (device.customer_id !== req.user.id) {
        return res.status(403).json({
          message: "You do not have permission to delete this device.",
        });
      }
    }

    await db.query("DELETE FROM devices WHERE id = ?", [id]);

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
