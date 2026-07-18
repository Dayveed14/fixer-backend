const db = require("../config/db");

/* ===========================
   REGISTER DEVICE
=========================== */

exports.createDevice = async (req, res) => {
  try {
    const { customer_id, device_name, brand, os, serial_number } = req.body;

    if (!customer_id || !device_name) {
      return res.status(400).json({
        message: "customer_id and device_name are required.",
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
    const customerId = Number(req.query.customer_id) || null;
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
