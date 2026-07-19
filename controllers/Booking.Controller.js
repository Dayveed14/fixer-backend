const db = require("../config/db");
const createNotification = require("../services/notificationService");
const sendMail = require("../services/mailService");

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

    const [[customer]] = await db.query(
      "SELECT first_name, last_name, email FROM users WHERE id = ?",
      [user_id],
    );

    if (!customer) {
      return res.status(404).json({
        message: "Customer not found.",
      });
    }

    const customerName = `${customer.first_name} ${customer.last_name}`;
    const customerEmail = customer.email;

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

    const bookingId = result.insertId;
    const booking_reference = `#BK${1000 + bookingId}`;

    await db.query("UPDATE bookings SET booking_reference = ? WHERE id = ?", [
      booking_reference,
      bookingId,
    ]);

    // Notification/email failures shouldn't turn a successful booking into
    // a 500 for the customer — the row is already committed at this point.
    // NOTE: the customer notification lives in here now too — it was
    // previously placed after this block, unprotected, which meant a
    // failure here would 500 a booking that had already succeeded.
    try {
      await createNotification({
        role: "admin",
        type: "booking",
        title: "New Booking",
        message: `${customerName} booked a ${typeInfo.db} session.`,
        reference_id: bookingId,
        reference_type: "booking",
      });

      await createNotification({
        user_id,
        role: "customer",
        type: "booking",
        title: "Booking Confirmed",
        message: `Your booking ${booking_reference} has been received.`,
        reference_id: bookingId,
        reference_type: "booking",
      });

      if (process.env.ADMIN_EMAIL) {
        await sendMail({
          to: process.env.ADMIN_EMAIL,
          subject: "New Booking",
          html: `
                <h2>New Booking</h2>

                <p><strong>Customer:</strong> ${customerName}</p>

                <p><strong>Support:</strong> ${typeInfo.db}</p>

                <p><strong>Date:</strong> ${booking_date}</p>

                <p><strong>Time:</strong> ${booking_time}</p>

                <p><strong>Issue:</strong> ${issue_summary || "N/A"}</p>

                <p><strong>Booking Ref:</strong> ${booking_reference}</p>`,
        });
      }

      if (customerEmail) {
        await sendMail({
          to: customerEmail,
          subject: "Booking Confirmation",
          html: `
                  <h2>Booking Confirmed</h2>

                  <p>Hi ${customer.first_name},</p>

                  <p>Your booking has been received successfully.</p>

                  <p><strong>Booking Ref:</strong> ${booking_reference}</p>
                  <p><strong>Support:</strong> ${typeInfo.db}</p>
                  <p><strong>Date:</strong> ${booking_date}</p>
                  <p><strong>Time:</strong> ${booking_time}</p>

                  <p>We'll assign a technician shortly.</p>

                  <p>Thank you,<br/>Fixer Support</p>
                  `,
        });
      }
    } catch (notifyError) {
      console.error(
        "Booking created but notification/email failed:",
        notifyError,
      );
    }

    return res.status(201).json({
      message: "Booking confirmed",
      id: bookingId,
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
   Moves status pending -> confirmed, auto-creates the linked
   repair ticket, and notifies/emails both the technician and
   the customer.
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
          bookings.booking_reference,
          bookings.booking_date,
          bookings.booking_time,
          bookings.issue_summary,
          bookings.device,
          bookings.ticket_id,
          CONCAT(customer.first_name, ' ', customer.last_name) AS customer_name,
          customer.email AS customer_email
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

    // Needed for the technician notification/email below — also doubles
    // as a guard against assigning a nonexistent or non-technician id.
    const [[technician]] = await connection.query(
      "SELECT first_name, last_name, email FROM users WHERE id = ? AND role = 'technician'",
      [technician_id],
    );

    if (!technician) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({
        message: "Technician not found.",
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

      await connection.query(
        "UPDATE tickets SET ticket_code = ? WHERE id = ?",
        [ticket_code, ticketId],
      );
    } else {
      await connection.query(
        "UPDATE tickets SET technician_id = ? WHERE id = ?",
        [technician_id, ticketId],
      );
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

    // Notifications/emails run only after a successful commit, and are
    // isolated in their own try/catch — a failure here must not roll
    // back or fail a technician assignment that already succeeded.
    try {
      const technicianName = `${technician.first_name} ${technician.last_name}`;

      await createNotification({
        user_id: technician_id,
        role: "technician",
        type: "assignment",
        title: "New Job Assigned",
        message: `You've been assigned booking ${booking.booking_reference}.`,
        reference_id: ticketId,
        reference_type: "ticket",
      });

      await createNotification({
        user_id: booking.user_id,
        role: "customer",
        type: "assignment",
        title: "Technician Assigned",
        message: `${technicianName} has been assigned to your booking ${booking.booking_reference}.`,
        reference_id: booking.id,
        reference_type: "booking",
      });

      if (technician.email) {
        await sendMail({
          to: technician.email,
          subject: "New Job Assigned",
          html: `
                <h2>New job assigned</h2>

                <p>Hi ${technician.first_name},</p>

                <p>You've been assigned a new job.</p>

                <p><strong>Customer:</strong> ${booking.customer_name}</p>

                <p><strong>Booking Ref:</strong> ${booking.booking_reference}</p>

                <p><strong>Date:</strong> ${booking.booking_date}</p>

                <p><strong>Time:</strong> ${booking.booking_time}</p>

                <p><strong>Issue:</strong> ${booking.issue_summary || "N/A"}</p>
                `,
        });
      }

      if (booking.customer_email) {
        await sendMail({
          to: booking.customer_email,
          subject: "A technician has been assigned to your booking",
          html: `
                <h2>Technician assigned</h2>

                <p>Hi,</p>

                <p>${technicianName} has been assigned to your booking ${booking.booking_reference}.</p>

                <p><strong>Date:</strong> ${booking.booking_date}</p>

                <p><strong>Time:</strong> ${booking.booking_time}</p>

                <p>Thank you,<br/>Fixer Support</p>
                `,
        });
      }
    } catch (notifyError) {
      console.error(
        "Technician assigned but notification/email failed:",
        notifyError,
      );
    }

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

    await db.query("UPDATE bookings SET status = ? WHERE id = ?", [status, id]);

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
