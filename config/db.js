const mysql = require("mysql2");

// TLS to the database is on by default (the hosted MySQL requires it).
// Set DB_SSL=false only for a local or CI database without TLS.
const useSsl = String(process.env.DB_SSL ?? "true").toLowerCase() !== "false";

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  port: process.env.DB_PORT,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
  queueLimit: 0,
  ssl: useSsl
    ? {
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      }
    : undefined,
});

module.exports = pool.promise();
