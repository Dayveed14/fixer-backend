const db = require("../config/db");

/* ===========================
   CREATE RATING
   Customer rates a completed ticket.
=========================== */

exports.createRating = async (req, res) => {
  try {
    const { ticket_id, technician_id, rating, comment } = req.body;
    // Always the caller's own id — a customer can only leave a rating as
    // themselves, not attribute one to someone else's account.
    const customer_id = req.user.id;

    if (!ticket_id || !technician_id || !rating) {
      return res.status(400).json({
        message: "ticket_id, technician_id and rating are required.",
      });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        message: "rating must be between 1 and 5.",
      });
    }

    // The ticket has to actually be this customer's, and the technician
    // being rated has to be the one who actually worked it — otherwise
    // anyone could post a rating against a stranger's completed job.
    const [[ticket]] = await db.query(
      "SELECT customer_id, technician_id FROM tickets WHERE id = ?",
      [ticket_id],
    );

    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found." });
    }

    if (ticket.customer_id !== customer_id) {
      return res.status(403).json({
        message: "You can only rate your own tickets.",
      });
    }

    if (Number(ticket.technician_id) !== Number(technician_id)) {
      return res.status(400).json({
        message: "technician_id does not match this ticket.",
      });
    }

    const sql = `
      INSERT INTO ratings
      (
        ticket_id,
        technician_id,
        customer_id,
        rating,
        comment
      )
      VALUES (?, ?, ?, ?, ?)
    `;

    const [result] = await db.query(sql, [
      ticket_id,
      technician_id,
      customer_id,
      rating,
      comment || null,
    ]);

    return res.status(201).json({
      message: "Rating submitted",
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
   GET TECHNICIAN RATINGS
=========================== */

exports.getTechnicianRatings = async (req, res) => {
  try {
    const { technicianId } = req.params;

    const [ratings] = await db.query(
      `
        SELECT id, ticket_id, customer_id, rating, comment, created_at
        FROM ratings
        WHERE technician_id = ?
        ORDER BY created_at DESC
      `,
      [technicianId],
    );

    return res.json(ratings);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};
