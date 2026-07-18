const db = require("../config/db");

// Matches the $ pricing shown in BookCall.jsx's SUPPORT_TYPES.
// Frontend uses "remote" as the id; DB enum uses "remote_desktop".
const SUPPORT_TYPE_MAP = {
  voice: { db: "voice", amount: 29 },
  video: { db: "video", amount: 49 },
  remote: { db: "remote_desktop", amount: 69 },
};

/* ===========================
   CREATE BOOKING
   Called when a customer completes the BookCall.jsx flow.
   Payment is mocked: no real charge, just recorded as "paid".
=========================== */

exports.createBooking = async (req, res) => {
  try {
    const {
      user_id,
      support_type, // "voice" | "video" | "remote" (frontend ids)
      booking_date,
      booking_time,
      duration,
      issue_summary,
      device,
      diagnosis_id,
    } = req.body;

    if (!user_id || !support_type || !booking_date || !booking_time) {
      return res.status(400).json({
        message:
          "user_id, support_type, booking_date and booking_time are required.",
      });
    }

    const typeInfo = SUPPORT_TYPE_MAP[support_type];

    if (!typeInfo) {
      return res.status(400).json({
        message: "Invalid support_type.",
      });
    }

    // Insert first (booking_reference is a placeholder), then derive the
    // human-readable reference from the real auto-increment ID.
    const insertSql = `
      INSERT INTO bookings
      (
        booking_reference,
        user_id,
        support_type,
        booking_date,
        booking_time,
        duration,
        issue_summary,
        device,
        amount,
        payment_status,
        diagnosis_id,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, 'pending')
    `;

    const [result] = await db.query(insertSql, [
      "PENDING",
      user_id,
      typeInfo.db,
      booking_date,
      booking_time,
      duration || 30,
      issue_summary || null,
      device || null,
      typeInfo.amount,
      diagnosis_id || null,
    ]);

    const booking_reference = `#BK${1000 + result.insertId}`;

    await db.query("UPDATE bookings SET booking_reference = ? WHERE id = ?", [
      booking_reference,
      result.insertId,
    ]);

    return res.status(201).json({
      message: "Booking confirmed",
      id: result.insertId,
      booking_reference,
      amount: typeInfo.amount,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   GET BOOKINGS
   Filters: user_id, technician_id, status, today, upcoming, limit
=========================== */

exports.getBookings = async (req, res) => {
  try {
    const userId = Number(req.query.user_id) || null;
    const technicianId = Number(req.query.technician_id) || null;
    const status = req.query.status || null;
    const today = req.query.today === "true";
    const upcoming = req.query.upcoming === "true";
    const limit = Number(req.query.limit) || null;

    let sql = `
      SELECT
        bookings.id,
        bookings.booking_reference,
        bookings.user_id,
        CONCAT(customer.first_name, ' ', customer.last_name) AS customer_name,
        bookings.support_type,
        bookings.booking_date,
        bookings.booking_time,
        bookings.duration,
        bookings.issue_summary,
        bookings.device,
        bookings.amount,
        bookings.payment_status,
        bookings.technician_id,
        CONCAT(tech.first_name, ' ', tech.last_name) AS technician_name,
        bookings.ticket_id,
        bookings.status,
        bookings.created_at
      FROM bookings
      INNER JOIN users AS customer
        ON customer.id = bookings.user_id
      LEFT JOIN users AS tech
        ON tech.id = bookings.technician_id
    `;

    const params = [];
    const conditions = [];

    if (userId) {
      conditions.push("bookings.user_id = ?");
      params.push(userId);
    }

    if (technicianId) {
      conditions.push("bookings.technician_id = ?");
      params.push(technicianId);
    }

    if (status) {
      conditions.push("bookings.status = ?");
      params.push(status);
    }

    if (today) {
      conditions.push("bookings.booking_date = CURDATE()");
    }

    if (upcoming) {
      conditions.push("bookings.booking_date >= CURDATE()");
      conditions.push("bookings.status IN ('pending', 'confirmed')");
    }

    if (conditions.length) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    sql += " ORDER BY bookings.booking_date ASC, bookings.booking_time ASC";

    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    const [bookings] = await db.query(sql, params);

    return res.json(bookings);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   ASSIGN TECHNICIAN (admin action)
   Moves status pending -> confirmed and auto-creates the
   linked repair ticket, per the agreed workflow.
=========================== */

exports.assignTechnician = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;
    const { technician_id } = req.body;

    if (!technician_id) {
      connection.release();
      return res.status(400).json({
        message: "technician_id is required.",
      });
    }

    await connection.beginTransaction();

    const [[booking]] = await connection.query(
      `
        SELECT
          bookings.id,
          bookings.user_id,
          bookings.issue_summary,
          bookings.device,
          bookings.ticket_id,
          CONCAT(customer.first_name, ' ', customer.last_name) AS customer_name
        FROM bookings
        INNER JOIN users AS customer
          ON customer.id = bookings.user_id
        WHERE bookings.id = ?
        FOR UPDATE
      `,
      [id],
    );

    if (!booking) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({
        message: "Booking not found.",
      });
    }

    let ticketId = booking.ticket_id;

    // Only create a ticket the first time a technician is assigned —
    // reassigning later just updates technician_id on both rows.
    if (!ticketId) {
      const [ticketResult] = await connection.query(
        `
          INSERT INTO tickets
          (
            ticket_code,
            customer_id,
            customer_name,
            issue,
            device,
            priority,
            technician_id,
            status
          )
          VALUES (?, ?, ?, ?, ?, 'Medium', ?, 'Open')
        `,
        [
          "PENDING",
          booking.user_id,
          booking.customer_name,
          booking.issue_summary || "Booked support call",
          booking.device,
          technician_id,
        ],
      );

      ticketId = ticketResult.insertId;

      const ticket_code = `#TK${1000 + ticketId}`;

      await connection.query("UPDATE tickets SET ticket_code = ? WHERE id = ?", [
        ticket_code,
        ticketId,
      ]);
    } else {
      await connection.query("UPDATE tickets SET technician_id = ? WHERE id = ?", [
        technician_id,
        ticketId,
      ]);
    }

    await connection.query(
      `
        UPDATE bookings
        SET technician_id = ?, ticket_id = ?, status = 'confirmed'
        WHERE id = ?
      `,
      [technician_id, ticketId, id],
    );

    await connection.commit();
    connection.release();

    return res.json({
      message: "Technician assigned and ticket linked",
      ticket_id: ticketId,
    });
  } catch (error) {
    await connection.rollback();
    connection.release();

    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   UPDATE BOOKING STATUS
   For completed / cancelled / missed transitions.
=========================== */

exports.updateBookingStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowedStatuses = [
      "pending",
      "confirmed",
      "completed",
      "cancelled",
      "missed",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        message: "Invalid status.",
      });
    }

    await db.query("UPDATE bookings SET status = ? WHERE id = ?", [
      status,
      id,
    ]);

    return res.json({
      message: "Booking status updated",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};
