// Shared helpers for the real-database tests. Each test file must also
// jest.mock the external services (see the top of any *.int.test.js).
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../../config/db");

const DATA_TABLES = [
  "payment_events",
  "payment_transactions",
  "shipment_events",
  "shipments",
  "ratings",
  "bookings",
  "tickets",
  "devices",
  "notifications",
  "diagnosis_requests",
  "articles",
  "diy_videos",
  "users",
];

/** Empties every data table (pricing tables keep their seeded prices). */
async function resetData() {
  const conn = await db.getConnection();
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of DATA_TABLES) await conn.query(`DELETE FROM \`${table}\``);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    conn.release();
  }
  require("../../services/sessionService").clearSessionCache();
}

let counter = 0;
async function createUser({ role = "user", password = "password-123", ...extra } = {}) {
  counter += 1;
  const email = extra.email || `${role}${counter}-${Date.now()}@example.com`;
  const [result] = await db.query(
    "INSERT INTO users (first_name, last_name, email, phone, password, role) VALUES (?, ?, ?, ?, ?, ?)",
    [extra.first_name || "Test", extra.last_name || role, email, "08030000000", await bcrypt.hash(password, 4), role],
  );
  return { id: result.insertId, email, role, password, tv: 0 };
}

/** Bearer header exactly like a login-issued token. */
function auth(user) {
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, tv: user.tv || 0 }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "1h",
  });
  return `Bearer ${token}`;
}

async function count(table, where = "1=1", params = []) {
  const [[row]] = await db.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where}`, params);
  return Number(row.n);
}

module.exports = { db, resetData, createUser, auth, count };
