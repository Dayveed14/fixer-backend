const db = require("../config/db");

/* ===========================
   GET NOTIFICATIONS
   Returns everything addressed to this user directly, plus anything
   broadcast to their role (user_id IS NULL rows from createNotification).
   Also returns the unread count so the bell badge doesn't need a
   separate request.
=========================== */
exports.getNotifications = async (req, res) => {
  try {
    // Identity comes from the verified token, never from the query string —
    // otherwise any logged-in user could read anyone else's notifications
    // just by passing a different user_id.
    const userId = req.user.id;
    const role = req.user.role;
    const limit = Number(req.query.limit) || 20;

    const [notifications] = await db.query(
      `
        SELECT
          id, user_id, role, type, title, message,
          reference_id, reference_type, is_read, created_at
        FROM notifications
        WHERE (user_id = ?) OR (user_id IS NULL AND role = ?)
        ORDER BY created_at DESC
        LIMIT ?
      `,
      [userId, role, limit],
    );

    const [[{ unread }]] = await db.query(
      `
        SELECT COUNT(*) AS unread
        FROM notifications
        WHERE ((user_id = ?) OR (user_id IS NULL AND role = ?))
          AND is_read = 0
      `,
      [userId, role],
    );

    return res.json({ notifications, unread });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   MARK ONE AS READ
=========================== */
exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params;

    // Only touch it if it's actually addressed to this user (directly, or
    // broadcast to their role) — otherwise any authenticated user could
    // flip the read state on someone else's notification by id.
    const [result] = await db.query(
      `
        UPDATE notifications
        SET is_read = 1
        WHERE id = ?
          AND ((user_id = ?) OR (user_id IS NULL AND role = ?))
      `,
      [id, req.user.id, req.user.role],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Notification not found.",
      });
    }

    return res.json({ message: "Notification marked as read" });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   MARK ALL AS READ (for this user + role)
=========================== */
exports.markAllAsRead = async (req, res) => {
  try {
    const user_id = req.user.id;
    const role = req.user.role;

    await db.query(
      `
        UPDATE notifications
        SET is_read = 1
        WHERE (user_id = ?) OR (user_id IS NULL AND role = ?)
      `,
      [user_id, role],
    );

    return res.json({ message: "All notifications marked as read" });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};
