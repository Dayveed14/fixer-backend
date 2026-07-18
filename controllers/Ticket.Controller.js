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
    const technicianId = Number(req.query.technician_id) || null;

    let sql = `
      SELECT
        tickets.id,
        tickets.ticket_code,
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
        ratings.rating AS existing_rating
      FROM tickets
      LEFT JOIN users AS tech
        ON tech.id = tickets.technician_id
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
   GET ACTIVE TICKET FOR TECHNICIAN
   Most recently updated "In Progress" ticket assigned to them —
   powers the "Current Customer" card.
=========================== */

exports.getActiveTicket = async (req, res) => {
  try {
    const { technicianId } = req.params;

    const [rows] = await db.query(
      `
        SELECT
          tickets.id,
          tickets.ticket_code,
          tickets.customer_name,
          tickets.issue,
          tickets.device,
          tickets.status,
          tickets.updated_at
        FROM tickets
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
