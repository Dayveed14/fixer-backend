const db = require("../config/db");

/* ===========================
   CREATE TICKET
=========================== */

exports.createTicket = async (req, res) => {
  try {
    const {
      customer_id,
      customer_name,
      issue,
      device,
      priority,
      technician_id,
      status,
    } = req.body;

    if (!customer_name || !issue) {
      return res.status(400).json({
        message: "customer_name and issue are required.",
      });
    }

    // Insert first (ticket_code is nullable at this point), then derive the
    // human-readable code from the real auto-increment ID and update it.
    const insertSql = `
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await db.query(insertSql, [
      "PENDING", // placeholder, overwritten below
      customer_id || null,
      customer_name,
      issue,
      device || null,
      priority || "Medium",
      technician_id || null,
      status || "Open",
    ]);

    const ticket_code = `#TK${1000 + result.insertId}`;

    await db.query("UPDATE tickets SET ticket_code = ? WHERE id = ?", [
      ticket_code,
      result.insertId,
    ]);

    return res.status(201).json({
      message: "Ticket created",
      id: result.insertId,
      ticket_code,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   GET TICKETS (list, with optional ?limit=)
=========================== */

exports.getTickets = async (req, res) => {
  try {
    const limit = Number(req.query.limit) || null;
    const customerId = Number(req.query.customer_id) || null;
    // Technicians only ever see their own tickets — token identity wins
    // over the query string, same as the bookings list.
    const technicianId =
      req.user.role === "technician"
        ? req.user.id
        : Number(req.query.technician_id) || null;

    let sql = `
      SELECT
        tickets.id,
        tickets.ticket_code,
        tickets.customer_id,
        tickets.customer_name,
        tickets.issue,
        tickets.device,
        tickets.priority,
        tickets.status,
        tickets.amount,
        tickets.technician_id,
        tickets.created_at,
        tickets.updated_at,
        CONCAT(tech.first_name, ' ', tech.last_name) AS technician_name,
        customer.email AS customer_email,
        customer.phone AS customer_phone,
        ratings.rating AS existing_rating
      FROM tickets
      LEFT JOIN users AS tech
        ON tech.id = tickets.technician_id
      LEFT JOIN users AS customer
        ON customer.id = tickets.customer_id
      LEFT JOIN ratings
        ON ratings.ticket_id = tickets.id
    `;

    const params = [];
    const conditions = [];

    if (customerId) {
      conditions.push("tickets.customer_id = ?");
      params.push(customerId);
    }

    if (technicianId) {
      conditions.push("tickets.technician_id = ?");
      params.push(technicianId);
    }

    if (conditions.length) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    sql += " ORDER BY tickets.created_at DESC";

    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    const [tickets] = await db.query(sql, params);

    return res.json(tickets);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   UPDATE TICKET STATUS
=========================== */

exports.updateTicketStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, amount } = req.body;

    const allowedStatuses = ["Open", "In Progress", "Completed", "Pending"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        message: "Invalid status.",
      });
    }

    // Technicians may only update tickets actually assigned to them.
    if (req.user.role === "technician") {
      const [[ticket]] = await db.query(
        "SELECT technician_id FROM tickets WHERE id = ?",
        [id],
      );

      if (!ticket) {
        return res.status(404).json({ message: "Ticket not found." });
      }

      if (ticket.technician_id !== req.user.id) {
        return res.status(403).json({
          message: "You are not assigned to this ticket.",
        });
      }
    }

    const sql = `
      UPDATE tickets
      SET status = ?, amount = ?
      WHERE id = ?
    `;

    await db.query(sql, [status, amount ?? null, id]);

    return res.json({
      message: "Ticket status updated",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   ASSIGN TECHNICIAN
=========================== */

exports.assignTechnician = async (req, res) => {
  try {
    const { id } = req.params;
    const { technician_id } = req.body;

    await db.query("UPDATE tickets SET technician_id = ? WHERE id = ?", [
      technician_id,
      id,
    ]);

    return res.json({
      message: "Technician assigned",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   UPDATE TICKET (admin edit)
   Full edit — issue, device, priority, status, amount, technician —
   distinct from updateTicketStatus which technicians use for the
   narrower status/amount-only update on their Assigned Jobs page.
=========================== */

exports.updateTicket = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      customer_name,
      issue,
      device,
      priority,
      status,
      amount,
      technician_id,
    } = req.body;

    const allowedStatuses = ["Open", "In Progress", "Completed", "Pending"];
    const allowedPriorities = ["Low", "Medium", "High"];

    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({
        message: "Invalid status.",
      });
    }

    if (priority && !allowedPriorities.includes(priority)) {
      return res.status(400).json({
        message: "Invalid priority.",
      });
    }

    if (!customer_name || !issue) {
      return res.status(400).json({
        message: "customer_name and issue are required.",
      });
    }

    const [result] = await db.query(
      `
        UPDATE tickets
        SET
          customer_name = ?,
          issue = ?,
          device = ?,
          priority = ?,
          status = ?,
          amount = ?,
          technician_id = ?
        WHERE id = ?
      `,
      [
        customer_name,
        issue,
        device || null,
        priority || "Medium",
        status || "Open",
        amount === "" || amount === undefined ? null : amount,
        technician_id || null,
        id,
      ],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Ticket not found.",
      });
    }

    return res.json({
      message: "Ticket updated",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   DELETE TICKET
=========================== */

exports.deleteTicket = async (req, res) => {
  try {
    const { id } = req.params;

    await db.query("DELETE FROM tickets WHERE id = ?", [id]);

    return res.json({
      message: "Ticket deleted",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   GET SINGLE TICKET (by id)
   Powers the customer-facing job detail page.
=========================== */

exports.getTicketById = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      `
        SELECT
          tickets.id,
          tickets.ticket_code,
          tickets.customer_id,
          tickets.customer_name,
          tickets.issue,
          tickets.device,
          tickets.priority,
          tickets.status,
          tickets.amount,
          tickets.technician_id,
          tickets.created_at,
          tickets.updated_at,
          CONCAT(tech.first_name, ' ', tech.last_name) AS technician_name,
          tech.email AS technician_email,
          tech.phone AS technician_phone,
          ratings.rating AS existing_rating,
          ratings.comment AS existing_rating_comment
        FROM tickets
        LEFT JOIN users AS tech
          ON tech.id = tickets.technician_id
        LEFT JOIN ratings
          ON ratings.ticket_id = tickets.id
        WHERE tickets.id = ?
      `,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Ticket not found.",
      });
    }

    const ticket = rows[0];

    const isOwner = req.user.role === "admin" ||
      ticket.customer_id === req.user.id ||
      ticket.technician_id === req.user.id;

    if (!isOwner) {
      return res.status(403).json({
        message: "You do not have permission to view this ticket.",
      });
    }

    return res.json(ticket);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   GET ACTIVE TICKET FOR TECHNICIAN
   Most recently updated "In Progress" ticket assigned to them —
   powers the "Current Customer" card.
=========================== */

exports.getActiveTicket = async (req, res) => {
  try {
    const { technicianId } = req.params;

    // A technician can only ever pull their own active ticket — admins
    // may look up any technician's.
    if (req.user.role === "technician" && Number(technicianId) !== req.user.id) {
      return res.status(403).json({
        message: "You do not have permission to view this technician's ticket.",
      });
    }

    const [rows] = await db.query(
      `
        SELECT
          tickets.id,
          tickets.ticket_code,
          tickets.customer_name,
          tickets.issue,
          tickets.device,
          tickets.status,
          tickets.updated_at,
          customer.email AS customer_email,
          customer.phone AS customer_phone
        FROM tickets
        LEFT JOIN users AS customer
          ON customer.id = tickets.customer_id
        WHERE tickets.technician_id = ?
          AND tickets.status = 'In Progress'
        ORDER BY tickets.updated_at DESC
        LIMIT 1
      `,
      [technicianId],
    );

    if (rows.length === 0) {
      return res.json(null);
    }

    return res.json(rows[0]);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};
