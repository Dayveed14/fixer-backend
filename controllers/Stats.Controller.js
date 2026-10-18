const db = require("../config/db");

/* ===========================
GET DASHBOARD STATS
Powers admin summary cards and System Health
=========================== */

exports.getDashboardStats = async (req, res) => {
try {
const [[{ totalUsers }]] = await db.query(
"SELECT COUNT(*) AS totalUsers FROM users WHERE role = 'user'"
);


const [[{ totalTechnicians }]] = await db.query(
  "SELECT COUNT(*) AS totalTechnicians FROM users WHERE role = 'technician'"
);

const [[{ openTickets }]] = await db.query(
  "SELECT COUNT(*) AS openTickets FROM tickets WHERE status IN ('Open', 'In Progress', 'Pending')"
);

const [[{ totalDevices }]] = await db.query(
  "SELECT COUNT(*) AS totalDevices FROM devices"
);

// Unassigned bookings awaiting technician assignment.
const [[{ unassignedBookings }]] = await db.query(`
  SELECT COUNT(*) AS unassignedBookings
  FROM bookings
  WHERE technician_id IS NULL
    AND LOWER(status) NOT IN ('cancelled', 'missed', 'completed')
`);

// Repairs paid for and delivered today.
const [[{ repairsToday }]] = await db.query(`
  SELECT COUNT(*) AS repairsToday
  FROM shipments
  WHERE payment_status = 'paid'
    AND LOWER(status) = 'delivered'
    AND delivered_at >= CURDATE()
    AND delivered_at < CURDATE() + INTERVAL 1 DAY
`);

// Repairs paid for but not yet delivered.
const [[{ pendingPaidRepairs }]] = await db.query(`
  SELECT COUNT(*) AS pendingPaidRepairs
  FROM shipments
  WHERE payment_status = 'paid'
    AND (
      status IS NULL
      OR LOWER(status) <> 'delivered'
    )
`);

// Combined workload requiring attention.
const pendingApprovals =
  Number(unassignedBookings) + Number(pendingPaidRepairs);

const [[{ currentMonthRevenue }]] = await db.query(`
  SELECT COALESCE(SUM(amount), 0) AS currentMonthRevenue
  FROM tickets
  WHERE status = 'Completed'
    AND MONTH(created_at) = MONTH(CURDATE())
    AND YEAR(created_at) = YEAR(CURDATE())
`);

const [[{ lastMonthRevenue }]] = await db.query(`
  SELECT COALESCE(SUM(amount), 0) AS lastMonthRevenue
  FROM tickets
  WHERE status = 'Completed'
    AND MONTH(created_at) = MONTH(CURDATE() - INTERVAL 1 MONTH)
    AND YEAR(created_at) = YEAR(CURDATE() - INTERVAL 1 MONTH)
`);

let revenueChangePercent = null;

if (Number(lastMonthRevenue) > 0) {
  revenueChangePercent =
    ((Number(currentMonthRevenue) - Number(lastMonthRevenue)) /
      Number(lastMonthRevenue)) *
    100;
}

return res.json({
  totalUsers,
  totalTechnicians,
  openTickets,
  revenue: currentMonthRevenue,
  lastMonthRevenue,
  revenueChangePercent,
  totalDevices,
  repairsToday,
  unassignedCalls: pendingApprovals,
  pendingApprovals,
});


} catch (error) {
console.error("Dashboard stats error:", error);


return res.status(500).json({
  message: "Internal Server Error",
});


}
};



/* ===========================
   GET TECHNICIAN STATS
   Powers the technician dashboard cards + Performance %.
=========================== */

/* ===========================
GET TECHNICIAN STATS
Powers technician dashboard cards and performance.
=========================== */

exports.getTechnicianStats = async (req, res) => {
      try {
      const { technicianId } = req.params;

      if (!technicianId || !Number.isInteger(Number(technicianId))) {
        return res.status(400).json({
          message: "A valid technicianId is required.",
        });
      }

      // A technician can only view their own stats.
      // Admins can view any technician's stats.
      if (
        req.user.role === "technician" &&
        Number(technicianId) !== Number(req.user.id)
      ) {
        return res.status(403).json({
          message: "You do not have permission to view these stats.",
        });
      }

      // All tickets assigned to this technician.
      const [[{ assignedJobs }]] = await db.query(
        `
          SELECT COUNT(*) AS assignedJobs
          FROM tickets
          WHERE technician_id = ?
        `,
        [technicianId]
      );

      // Tickets completed today.
      const [[{ completedToday }]] = await db.query(
        `
          SELECT COUNT(*) AS completedToday
          FROM tickets
          WHERE technician_id = ?
            AND LOWER(status) = 'completed'
            AND updated_at >= CURDATE()
            AND updated_at < CURDATE() + INTERVAL 1 DAY
        `,
        [technicianId]
      );

      // Assigned tickets still awaiting completion.
      const [[{ pendingRepairs }]] = await db.query(
        `
          SELECT COUNT(*) AS pendingRepairs
          FROM tickets
          WHERE technician_id = ?
            AND LOWER(status) IN ('open', 'pending', 'in progress')
        `,
        [technicianId]
      );

      // All completed tickets assigned to this technician.
      const [[{ devicesRepaired }]] = await db.query(
        `
          SELECT COUNT(*) AS devicesRepaired
          FROM tickets
          WHERE technician_id = ?
            AND LOWER(status) = 'completed'
        `,
        [technicianId]
      );

      // Average customer rating and number of submitted ratings.
      const [[{ avgRating, ratingCount }]] = await db.query(
        `
          SELECT
            AVG(rating) AS avgRating,
            COUNT(*) AS ratingCount
          FROM ratings
          WHERE technician_id = ?
        `,
        [technicianId]
      );

      const performancePercent =
        avgRating !== null && avgRating !== undefined
          ? Math.round((Number(avgRating) / 5) * 100)
          : null;

      return res.json({
        assignedJobs: Number(assignedJobs),
        completedToday: Number(completedToday),
        pendingRepairs: Number(pendingRepairs),
        devicesRepaired: Number(devicesRepaired),
        performancePercent,
        ratingCount: Number(ratingCount),
      });

      } catch (error) {
      console.error("Technician dashboard stats error:", error);

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

  // A regular user can only access their own dashboard stats.
  if (
    req.user.role === "user" &&
    Number(userId) !== Number(req.user.id)
  ) {
    return res.status(403).json({
      message: "You do not have permission to view these stats.",
    });
  }

  // Repairs paid for but not yet delivered.
  const [[{ repairsInProgress }]] = await db.query(
    `
      SELECT COUNT(*) AS repairsInProgress
      FROM shipments
      WHERE user_id = ?
        AND payment_status = 'paid'
        AND (
          status IS NULL
          OR LOWER(status) <> 'delivered'
        )
    `,
    [userId]
  );

  // AI diagnoses submitted by the customer.
  const [[{ aiDiagnoses }]] = await db.query(
    `
      SELECT COUNT(*) AS aiDiagnoses
      FROM diagnosis_requests
      WHERE user_id = ?
    `,
    [userId]
  );

  // Upcoming appointments awaiting completion.
  const [[{ appointmentsCount }]] = await db.query(
    `
      SELECT COUNT(*) AS appointmentsCount
      FROM bookings
      WHERE user_id = ?
        AND booking_date >= CURDATE()
        AND LOWER(status) IN ('pending', 'confirmed')
    `,
    [userId]
  );

  // Devices registered by the customer.
  const [[{ registeredDevices }]] = await db.query(
    `
      SELECT COUNT(*) AS registeredDevices
      FROM devices
      WHERE customer_id = ?
    `,
    [userId]
  );

  return res.json({
    repairsInProgress,
    aiDiagnoses,
    appointmentsCount,
    registeredDevices,
  });

  } catch (error) {
  console.error("User dashboard stats error:", error);

  return res.status(500).json({
    message: "Internal Server Error",
  });

  }
  };

