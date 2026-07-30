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
    const userId = Number(req.query.user_id) || null;
    const role = req.query.role || null;
    const limit = Number(req.query.limit) || 20;

    if (!userId || !role) {
      return res.status(400).json({
        message: "user_id and role are required.",
      });
    }

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

    await db.query("UPDATE notifications SET is_read = 1 WHERE id = ?", [id]);

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
    const { user_id, role } = req.body;

    if (!user_id || !role) {
      return res.status(400).json({
        message: "user_id and role are required.",
      });
    }

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
