const db = require("../config/db");

/* ===========================
   CREATE RATING
   Customer rates a completed ticket.
=========================== */

exports.createRating = async (req, res) => {
  try {
    const { ticket_id, technician_id, customer_id, rating, comment } =
      req.body;

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
      customer_id || null,
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
