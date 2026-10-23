const db = require("../config/db");
const { parseLimit } = require("../utils/validate");
const { generateInviteLink } = require("../services/meshCentralService");
const createNotification = require("../services/notificationService");
const sendMail = require("../services/mailService");
const {
  confirmPayment,
  fulfillPayment,
} = require("../services/paymentService");
const { sendPaymentError } = require("./Payment.Controller");
const pricing = require("../services/pricingService");
const {
  availableSlots,
  allSlots,
  normalizeTime,
  parseDate,
  LEAD_MINUTES,
} = require("../utils/schedule");
const escapeHtml = require("../utils/escapeHtml");
const { createVideoMeeting } = require("../services/meetingService");

const MAX_ISSUE_LENGTH = 2000;
const MAX_DEVICE_LENGTH = 60;

/* ===========================
   SUPPORT TYPES + SLOTS (public)
   GET /api/bookings/support-types
   GET /api/bookings/slots?date=YYYY-MM-DD
=========================== */
exports.getSupportTypes = async (req, res) => {
  try {
    const types = await pricing.getSupportTypes();
    return res.json(types.map(({ id, title, amount }) => ({ id, title, amount })));
  } catch (err) {
    console.error("Support types error:", err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

exports.getBookingSlots = (req, res) => {
  const { date } = req.query;
  if (!parseDate(date)) {
    return res.status(400).json({ message: "date must be YYYY-MM-DD." });
  }
  return res.json({
    date,
    lead_minutes: LEAD_MINUTES.booking,
    all: allSlots("booking"),
    available: availableSlots(date, "booking"),
  });
};

/* ===========================
   CREATE BOOKING
   Called when a customer completes the BookCall.jsx flow, after paying
   with a reference from POST /api/payments/initialize. The payment is
   re-verified with Paystack and checked against the server-side
   payment record (owner, amount, currency, support type and slot)
   before anything is written — see services/paymentService.js.
=========================== */

exports.createBooking = async (req, res) => {
  try {
    const {
      support_type, // "voice" | "video" | "remote" (frontend ids)
      booking_date,
      booking_time,
      issue_summary,
      device,
      diagnosis_id,
      payment_reference,
    } = req.body || {};

    // Always the caller's own id from the verified token — a booking can
    // only ever be created for the account that's actually logged in.
    const user_id = req.user.id;

    if (
      !support_type ||
      !booking_date ||
      !booking_time ||
      !payment_reference
    ) {
      return res.status(400).json({
        message:
          "support_type, booking_date, booking_time and payment_reference are required.",
      });
    }

    const typeInfo = await pricing.getSupportType(support_type);

    if (!typeInfo) {
      return res.status(400).json({
        message: "Invalid support_type.",
      });
    }

    const bookingTime = normalizeTime(booking_time);
    if (!parseDate(booking_date) || !bookingTime) {
      return res.status(400).json({ message: "Invalid booking date or time." });
    }

    if (issue_summary && String(issue_summary).length > MAX_ISSUE_LENGTH) {
      return res.status(400).json({
        message: `issue_summary must be at most ${MAX_ISSUE_LENGTH} characters.`,
      });
    }

    if (device && String(device).length > MAX_DEVICE_LENGTH) {
      return res.status(400).json({
        message: `device must be at most ${MAX_DEVICE_LENGTH} characters.`,
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

    const payment = await confirmPayment({
      reference: payment_reference,
      userId: user_id,
      purpose: "booking",
      details: {
        support_type: typeInfo.id,
        booking_date,
        booking_time: bookingTime,
      },
    });

    const amountNaira = Number(payment.amount_kobo) / 100;

    const { entityId: bookingId, alreadyFulfilled } = await fulfillPayment({
      reference: payment.reference,
      entityType: "booking",
      actorUserId: user_id,
      create: async (connection) => {
        const [result] = await connection.query(
          `
          INSERT INTO bookings
          (
            booking_reference, user_id, support_type, booking_date,
            booking_time, duration, issue_summary, device, amount,
            payment_status, payment_reference, diagnosis_id, status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, 'pending')
          `,
          [
            "PENDING",
            user_id,
            typeInfo.db,
            booking_date,
            bookingTime,
            30,
            issue_summary || null,
            device || null,
            amountNaira,
            payment.reference,
            diagnosis_id || null,
          ],
        );

        const id = result.insertId;
        await connection.query(
          "UPDATE bookings SET booking_reference = ? WHERE id = ?",
          [`#BK${1000 + id}`, id],
        );
        return id;
      },
    });

    const booking_reference = `#BK${1000 + Number(bookingId)}`;

    if (alreadyFulfilled) {
      return res.status(200).json({
        message: "Booking already confirmed for this payment",
        id: bookingId,
        booking_reference,
        amount: amountNaira,
      });
    }

    const customerName = `${customer.first_name} ${customer.last_name}`;
    const customerEmail = customer.email;

    // Video calls get their meeting link now, so the customer has it
    // immediately and the technician just opens it at the session time.
    let meetingUrl = null;
    if (typeInfo.db === "video") {
      try {
        const meeting = await createVideoMeeting({
          bookingReference: booking_reference,
          startsAt: `${booking_date}T${bookingTime}+01:00`,
          durationMinutes: 30,
          customerEmail,
          summary: `Fixer video support ${booking_reference}`,
        });
        meetingUrl = meeting.url;
        await db.query(
          "UPDATE bookings SET meeting_url = ?, meeting_provider = ? WHERE id = ?",
          [meeting.url, meeting.provider, bookingId],
        );
      } catch (meetingError) {
        // Staff can create it later from the appointment.
        console.error("Meeting link not saved:", meetingError.message);
      }
    }

    const safeName = escapeHtml(customerName);
    const safeIssue = escapeHtml(issue_summary || "N/A");
    const timeLabel = bookingTime.slice(0, 5);

    // Notification/email failures shouldn't turn a successful booking into
    // a 500 for the customer — the row is already committed at this point.
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
                <p><strong>Customer:</strong> ${safeName}</p>
                <p><strong>Support:</strong> ${typeInfo.db}</p>
                <p><strong>Date:</strong> ${booking_date}</p>
                <p><strong>Time:</strong> ${timeLabel}</p>
                <p><strong>Issue:</strong> ${safeIssue}</p>
                <p><strong>Booking Ref:</strong> ${booking_reference}</p>`,
        }, "admin");
      }

      if (customerEmail) {
        await sendMail({
          to: customerEmail,
          subject: "Booking Confirmation",
          html: `
                  <h2>Booking Confirmed</h2>
                  <p>Hi ${escapeHtml(customer.first_name)},</p>
                  <p>Your booking has been received successfully.</p>
                  <p><strong>Booking Ref:</strong> ${booking_reference}</p>
                  <p><strong>Support:</strong> ${typeInfo.db}</p>
                  <p><strong>Date:</strong> ${booking_date}</p>
                  <p><strong>Time:</strong> ${timeLabel}</p>
                  <p>We'll assign a technician shortly.</p>
                  <p>Thank you,<br/>Fixer Support</p>
                  `,
        }, "support");
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
      amount: amountNaira,
      meeting_url: meetingUrl,
    });
  } catch (error) {
    if (error.name === "PaymentError") {
      return sendPaymentError(res, error);
    }

    console.error(error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "This payment has already been used for a booking.",
      });
    }

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
    // Everyone gets scoped to their own bookings except admins:
    // - a customer only ever sees their own (user_id forced to self)
    // - a technician only ever sees their own queue (technician_id forced to self)
    // - an admin can filter by whichever user_id/technician_id they pass
    const userId =
      req.user.role === "user"
        ? req.user.id
        : Number(req.query.user_id) || null;
    const technicianId =
      req.user.role === "technician"
        ? req.user.id
        : Number(req.query.technician_id) || null;
    const status = req.query.status || null;
    const today = req.query.today === "true";
    const upcoming = req.query.upcoming === "true";
    const limit = parseLimit(req.query.limit, 200);

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
        bookings.meeting_url,
        customer.phone AS customer_phone,
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
   GET SINGLE BOOKING (by id)
   Powers the customer-facing appointment detail page.
=========================== */

exports.getBookingById = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      `
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
          bookings.meeting_url,
          customer.phone AS customer_phone,
          bookings.technician_id,
          CONCAT(tech.first_name, ' ', tech.last_name) AS technician_name,
          tech.email AS technician_email,
          tech.phone AS technician_phone,
          bookings.ticket_id,
          bookings.status,
          bookings.created_at
        FROM bookings
        INNER JOIN users AS customer
          ON customer.id = bookings.user_id
        LEFT JOIN users AS tech
          ON tech.id = bookings.technician_id
        WHERE bookings.id = ?
      `,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Booking not found.",
      });
    }

    const booking = rows[0];

    // Ownership check: the customer who owns it, the technician assigned
    // to it, or an admin. Anyone else authenticated shouldn't be able to
    // pull up a stranger's booking just by guessing the id.
    const isOwner = req.user.role === "admin" ||
      booking.user_id === req.user.id ||
      booking.technician_id === req.user.id;

    if (!isOwner) {
      return res.status(403).json({
        message: "You do not have permission to view this booking.",
      });
    }

    return res.json(booking);
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
        }, "notifications");
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
        }, "support");
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

    // Customers may only cancel their own booking — nothing else.
    // Technicians may only move bookings that are actually assigned to
    // them. Admins can set any status on any booking.
    if (req.user.role === "user") {
      if (status !== "cancelled") {
        return res.status(403).json({
          message: "You can only cancel your own booking.",
        });
      }

      const [[booking]] = await db.query(
        "SELECT user_id FROM bookings WHERE id = ?",
        [id],
      );

      if (!booking) {
        return res.status(404).json({ message: "Booking not found." });
      }

      if (booking.user_id !== req.user.id) {
        return res.status(403).json({
          message: "You do not have permission to cancel this booking.",
        });
      }
    } else if (req.user.role === "technician") {
      const [[booking]] = await db.query(
        "SELECT technician_id FROM bookings WHERE id = ?",
        [id],
      );

      if (!booking) {
        return res.status(404).json({ message: "Booking not found." });
      }

      if (booking.technician_id !== req.user.id) {
        return res.status(403).json({
          message: "You are not assigned to this booking.",
        });
      }
    }

    await db.query("UPDATE bookings SET status = ? WHERE id = ?", [status, id]);

    // Keep the linked ticket in step, so finishing the call finishes the
    // job everywhere. No amount is needed — the customer already paid.
    const ticketStatus = { completed: "Completed", cancelled: "Cancelled", missed: "Cancelled" }[status];
    if (ticketStatus === "Completed") {
      await db.query(
        "UPDATE tickets SET status = 'Completed' WHERE id = (SELECT ticket_id FROM bookings WHERE id = ?)",
        [id],
      );
    }

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

/* ===========================
   START REMOTE SESSION
   Generates a time-limited MeshCentral invite link for a confirmed
   booking. The technician sends this link to the customer; once they
   open it and install the temporary agent, the device shows up in the
   MeshCentral dashboard for the technician to take control from.
=========================== */

exports.startRemoteSession = async (req, res) => {
  try {
    const { id } = req.params;

    const [[booking]] = await db.query(
      `
        SELECT
          bookings.id,
          bookings.status,
          bookings.booking_reference,
          bookings.support_type,
          bookings.technician_id,
          CONCAT(customer.first_name, ' ', customer.last_name) AS customer_name,
          customer.email AS customer_email,
          CONCAT(tech.first_name, ' ', tech.last_name) AS technician_name
        FROM bookings
        INNER JOIN users AS customer
          ON customer.id = bookings.user_id
        LEFT JOIN users AS tech
          ON tech.id = bookings.technician_id
        WHERE bookings.id = ?
      `,
      [id],
    );

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found.",
      });
    }

    if (req.user.role === "technician" && booking.technician_id !== req.user.id) {
      return res.status(403).json({
        message: "You are not assigned to this booking.",
      });
    }

    // MeshCentral is only for remote-support bookings. Voice calls are
    // made by the technician; video calls use the booking's meeting link.
    if (booking.support_type && booking.support_type !== "remote_desktop") {
      return res.status(400).json({
        message:
          booking.support_type === "video"
            ? "This is a video call — open its meeting link instead."
            : "This is a voice call — call the customer instead.",
      });
    }

    if (booking.status !== "confirmed") {
      return res.status(400).json({
        message: "Only confirmed bookings can start a remote session.",
      });
    }

    const inviteLink = await generateInviteLink({ hours: 2 });

    // Isolated in its own try/catch — a mail failure shouldn't turn an
    // already-generated session into a 500 for the technician. They
    // still get inviteLink back in the response either way.
    if (booking.customer_email) {
      try {
        await sendMail({
          to: booking.customer_email,
          subject: "Your remote support session is ready",
          html: `
                <h2>Remote support session ready</h2>

                <p>Hi ${booking.customer_name},</p>

                <p>${booking.technician_name || "Your technician"} is ready to start your remote support session for booking ${booking.booking_reference}.</p>

                <p>Click the link below to install a temporary connection tool and begin:</p>

                <p><a href="${inviteLink}">${inviteLink}</a></p>

                <p>This link expires in 2 hours and only needs to be used once.</p>

                <p>Thank you,<br/>Fixer Support</p>
                `,
        }, "support");
      } catch (mailError) {
        console.error("Remote session started but email failed:", mailError);
      }
    }

    return res.json({ inviteLink });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: error.message || "Internal Server Error",
    });
  }
};

/* ===========================
   CREATE / REPLACE A VIDEO MEETING LINK (staff)
   POST /api/bookings/:id/meeting — for video bookings whose link
   couldn't be created at booking time, or needs replacing.
=========================== */
exports.createMeetingLink = async (req, res) => {
  try {
    const [[booking]] = await db.query(
      `SELECT bookings.id, bookings.booking_reference, bookings.support_type,
              bookings.booking_date, bookings.booking_time, bookings.technician_id,
              customer.email AS customer_email
         FROM bookings
         INNER JOIN users AS customer ON customer.id = bookings.user_id
        WHERE bookings.id = ?`,
      [req.params.id],
    );

    if (!booking) return res.status(404).json({ message: "Booking not found." });

    if (req.user.role === "technician" && booking.technician_id !== req.user.id) {
      return res.status(403).json({ message: "You are not assigned to this booking." });
    }

    if (booking.support_type !== "video") {
      return res.status(400).json({ message: "Only video calls have a meeting link." });
    }

    const date =
      booking.booking_date instanceof Date
        ? booking.booking_date.toISOString().slice(0, 10)
        : String(booking.booking_date).slice(0, 10);

    const meeting = await createVideoMeeting({
      bookingReference: booking.booking_reference,
      startsAt: `${date}T${String(booking.booking_time).slice(0, 8)}+01:00`,
      durationMinutes: 30,
      customerEmail: booking.customer_email,
    });

    await db.query(
      "UPDATE bookings SET meeting_url = ?, meeting_provider = ? WHERE id = ?",
      [meeting.url, meeting.provider, booking.id],
    );

    return res.json({ meeting_url: meeting.url, provider: meeting.provider });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};
