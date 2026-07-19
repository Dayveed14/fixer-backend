const db = require("../config/db");

const createNotification = async ({
  user_id = null,
  role,
  type,
  title,
  message,
  reference_id = null,
  reference_type = null,
}) => {
  try {
    await db.query(
      `
      INSERT INTO notifications
      (
        user_id,
        role,
        type,
        title,
        message,
        reference_id,
        reference_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [user_id, role, type, title, message, reference_id, reference_type],
    );
  } catch (err) {
    console.error("Notification Error:", err);
    throw err;
  }
};

module.exports = createNotification;
