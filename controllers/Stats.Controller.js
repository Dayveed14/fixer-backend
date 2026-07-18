const db = require("../config/db");

/* ===========================
   GET DASHBOARD STATS
   Powers the 4 admin summary cards
=========================== */

exports.getDashboardStats = async (req, res) => {
  try {
    const [[{ totalUsers }]] = await db.query(
      "SELECT COUNT(*) AS totalUsers FROM users WHERE role = 'user'",
    );

    const [[{ totalTechnicians }]] = await db.query(
      "SELECT COUNT(*) AS totalTechnicians FROM users WHERE role = 'technician'",
    );

    const [[{ openTickets }]] = await db.query(
      "SELECT COUNT(*) AS openTickets FROM tickets WHERE status IN ('Open', 'In Progress', 'Pending')",
    );
    const [[{ totalDevices }]] = await db.query(
      "SELECT COUNT(*) AS totalDevices FROM devices",
    );

    const [[{ unassignedCalls }]] = await db.query(
      "SELECT COUNT(*) AS unassignedCalls FROM bookings WHERE status = 'Pending'",
    );

    const [[{ currentMonthRevenue }]] = await db.query(
      `
        SELECT COALESCE(SUM(amount), 0) AS currentMonthRevenue
        FROM tickets
        WHERE status = 'Completed'
          AND MONTH(created_at) = MONTH(CURDATE())
          AND YEAR(created_at) = YEAR(CURDATE())
      `,
    );

    const [[{ lastMonthRevenue }]] = await db.query(
      `
        SELECT COALESCE(SUM(amount), 0) AS lastMonthRevenue
        FROM tickets
        WHERE status = 'Completed'
          AND MONTH(created_at) = MONTH(CURDATE() - INTERVAL 1 MONTH)
          AND YEAR(created_at) = YEAR(CURDATE() - INTERVAL 1 MONTH)
      `,
    );

    let revenueChangePercent = null;

    if (lastMonthRevenue > 0) {
      revenueChangePercent =
        ((currentMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100;
    }

    return res.json({
      totalUsers,
      totalTechnicians,
      openTickets,
      revenue: currentMonthRevenue,
      lastMonthRevenue,
      revenueChangePercent,
      totalDevices,
      unassignedCalls,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   GET TECHNICIAN STATS
   Powers the technician dashboard cards + Performance %.
=========================== */

exports.getTechnicianStats = async (req, res) => {
  try {
    const { technicianId } = req.params;

    if (!technicianId) {
      return res.status(400).json({
        message: "technicianId is required.",
      });
    }

    const [[{ assignedJobs }]] = await db.query(
      "SELECT COUNT(*) AS assignedJobs FROM tickets WHERE technician_id = ?",
      [technicianId],
    );

    const [[{ completedToday }]] = await db.query(
      `
        SELECT COUNT(*) AS completedToday
        FROM tickets
        WHERE technician_id = ?
          AND status = 'Completed'
          AND DATE(updated_at) = CURDATE()
      `,
      [technicianId],
    );

    const [[{ pendingRepairs }]] = await db.query(
      "SELECT COUNT(*) AS pendingRepairs FROM tickets WHERE technician_id = ? AND status IN ('Pending', 'Open')",
      [technicianId],
    );

    const [[{ devicesRepaired }]] = await db.query(
      "SELECT COUNT(*) AS devicesRepaired FROM tickets WHERE technician_id = ? AND status = 'Completed'",
      [technicianId],
    );

    const [[{ avgRating, ratingCount }]] = await db.query(
      `
        SELECT AVG(rating) AS avgRating, COUNT(*) AS ratingCount
        FROM ratings
        WHERE technician_id = ?
      `,
      [technicianId],
    );

    const performancePercent = avgRating
      ? Math.round((avgRating / 5) * 100)
      : null;

    return res.json({
      assignedJobs,
      completedToday,
      pendingRepairs,
      devicesRepaired,
      performancePercent,
      ratingCount,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

/* ===========================
   GET USER STATS
   Powers the logged-in user's dashboard cards.
=========================== */

exports.getUserStats = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        message: "userId is required.",
      });
    }

    const [[{ repairsInProgress }]] = await db.query(
      "SELECT COUNT(*) AS repairsInProgress FROM tickets WHERE customer_id = ? AND status = 'In Progress'",
      [userId],
    );

    const [[{ aiDiagnoses }]] = await db.query(
      "SELECT COUNT(*) AS aiDiagnoses FROM diagnosis_requests WHERE user_id = ?",
      [userId],
    );

    const [[{ appointmentsCount }]] = await db.query(
      "SELECT COUNT(*) AS appointmentsCount FROM bookings WHERE user_id = ? AND booking_date >= CURDATE() AND status IN ('pending', 'confirmed')",
      [userId],
    );

    const [[{ registeredDevices }]] = await db.query(
      "SELECT COUNT(*) AS registeredDevices FROM devices WHERE customer_id = ?",
      [userId],
    );

    return res.json({
      repairsInProgress,
      aiDiagnoses,
      appointmentsCount,
      registeredDevices,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};
