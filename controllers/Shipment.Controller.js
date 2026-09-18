const db = require("../config/db");
const sendMail = require("../services/mailService");
const { verifyPayment } = require("../services/paystackService");

// Fixed pickup fee — matches the "estimatedPickupFee" shown in Shipment.jsx.
const PICKUP_FEE_NAIRA = 2500;
const PICKUP_FEE_KOBO = 250000;

/* ===========================
   CREATE SHIPMENT (device pickup request)
   Called when a customer completes the Shipment.jsx wizard.
   Same rule as bookings: the frontend collects payment via the Paystack
   popup, but nothing is written to the DB until we've independently
   re-verified that reference with Paystack ourselves.
=========================== */
exports.createShipment = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      device,
      brand,
      fault,
      address,
      city,
      notes,
      pickup_date,
      pickup_time,
      payment_reference,
    } = req.body;

    if (
      !name ||
      !email ||
      !phone ||
      !device ||
      !brand ||
      !fault ||
      !address ||
      !city ||
      !pickup_date ||
      !pickup_time ||
      !payment_reference
    ) {
      return res.status(400).json({
        message: "Missing required fields.",
      });
    }

    try {
      await verifyPayment(payment_reference, PICKUP_FEE_KOBO);
    } catch (paymentError) {
      console.error(
        "Shipment payment verification failed:",
        paymentError.message,
      );

      return res.status(402).json({
        message: `Payment could not be verified: ${paymentError.message}`,
      });
    }

    const insertSql = `
      INSERT INTO shipments
      (
        reference,
        name,
        email,
        phone,
        device,
        brand,
        fault,
        address,
        city,
        notes,
        pickup_date,
        pickup_time,
        fee_amount,
        payment_status,
        payment_reference,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, 'pickup_scheduled')
    `;

    const [result] = await db.query(insertSql, [
      "PENDING",
      name,
      email,
      phone,
      device,
      brand,
      fault,
      address,
      city,
      notes || null,
      pickup_date,
      pickup_time,
      PICKUP_FEE_NAIRA,
      payment_reference,
    ]);

    const shipmentId = result.insertId;
    const reference = `FXR-${1000 + shipmentId}`;

    await db.query("UPDATE shipments SET reference = ? WHERE id = ?", [
      reference,
      shipmentId,
    ]);

    // Email failures shouldn't turn an already-committed, already-paid
    // shipment into a 500 for the customer.
    try {
      await sendMail(
        {
          to: email,
          subject: "Your device pickup is scheduled",
          html: `
            <p>Hi ${name},</p>
            <p>Your device pickup has been scheduled and payment received.</p>
            <p><strong>Reference:</strong> ${reference}</p>
            <p><strong>Device:</strong> ${brand} ${device}</p>
            <p><strong>Pickup:</strong> ${pickup_date} at ${pickup_time}</p>
            <p><strong>Address:</strong> ${address}, ${city}</p>
            <p>Thank you,<br/>Fixer Support</p>
          `,
        },
        "support",
      );

      if (process.env.ADMIN_EMAIL) {
        await sendMail(
          {
            to: process.env.ADMIN_EMAIL,
            subject: "New Device Pickup Request",
            html: `
              <p>${name} scheduled a device pickup.</p>
              <p><strong>Reference:</strong> ${reference}</p>
              <p><strong>Device:</strong> ${brand} ${device}</p>
              <p><strong>Fault:</strong> ${fault}</p>
              <p><strong>Pickup:</strong> ${pickup_date} at ${pickup_time}</p>
              <p><strong>Address:</strong> ${address}, ${city}</p>
            `,
          },
          "admin",
        );
      }
    } catch (notifyError) {
      console.error(
        "Shipment created but notification/email failed:",
        notifyError,
      );
    }

    return res.status(201).json({
      message: "Pickup scheduled",
      id: shipmentId,
      reference,
      fee_amount: PICKUP_FEE_NAIRA,
    });
  } catch (error) {
    console.error(error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "This payment has already been used for a pickup request.",
      });
    }

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

exports.getShipments = async (req, res) => {
  try {
    const [shipments] = await db.query(
      "SELECT * FROM shipments ORDER BY created_at DESC",
    );

    res.json(shipments);
  } catch (err) {
    res.status(500).json({
      message: "Server Error",
    });
  }
};

exports.getShipment = async (req, res) => {
  try {
    const { id } = req.params;

    // Allow lookup by numeric id or by the FXR-#### reference, so a
    // tracking page can use whichever the customer has on hand.
    const [rows] = await db.query(
      "SELECT * FROM shipments WHERE id = ? OR reference = ?",
      [id, id],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Shipment not found",
      });
    }

    const shipment = rows[0];

    // Shipments aren't tied to a user_id (they're taken from the form as
    // name/email/phone), so ownership is checked against the token's
    // email. Admins can look up anything.
    if (req.user.role !== "admin" && shipment.email !== req.user.email) {
      return res.status(403).json({
        message: "You do not have permission to view this shipment.",
      });
    }

    res.json(shipment);
  } catch (err) {
    res.status(500).json({
      message: "Server Error",
    });
  }
};

exports.updateShipmentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        message: "status is required.",
      });
    }

    await db.query("UPDATE shipments SET status = ? WHERE id = ?", [
      status,
      id,
    ]);

    res.json({
      message: "Shipment status updated",
    });
  } catch (err) {
    res.status(500).json({
      message: "Server Error",
    });
  }
};

exports.getUserShipment = async (req, res) => {
  try {
    const { email } = req.params;

    if (!email) {
      return res.status(400).json({
        message: "Email is required.",
      });
    }

    // A customer can only pull up their own shipment history — the
    // route is authenticated, but the :email param is still
    // caller-supplied, so without this check anyone logged in could
    // page through anyone else's shipments by email. Admins can look
    // up any email.
    if (req.user.role !== "admin" && email.toLowerCase() !== req.user.email.toLowerCase()) {
      return res.status(403).json({
        message: "You do not have permission to view these shipments.",
      });
    }

    const [rows] = await db.query(
      "SELECT * FROM shipments WHERE email = ? ORDER BY created_at DESC",
      [email],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: "No shipments found for this user.",
      });
    }

    res.json(rows);
  } catch (err) {
    console.error("Get user shipments error:", err);

    res.status(500).json({
      message: "Server Error",
    });
  }
};
