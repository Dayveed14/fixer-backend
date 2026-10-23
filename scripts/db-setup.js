#!/usr/bin/env node
/* ===========================
   Creates the database and brings it to the current schema:
   db/schema.sql (base tables) then every file in migrations/ in name
   order. Used by the integration tests and CI; also handy for a fresh
   local database.

   node scripts/db-setup.js           # create if missing, apply all
   node scripts/db-setup.js --reset   # drop and recreate first

   Reads DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL.
   Refuses to --reset when NODE_ENV=production.
=========================== */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const ROOT = path.join(__dirname, "..");

function migrationFiles() {
  const dir = path.join(ROOT, "migrations");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(dir, f));
}

async function setupDatabase({ reset = false, log = console.log } = {}) {
  const name = process.env.DB_NAME;
  if (!name || !/^[A-Za-z0-9_]+$/.test(name)) throw new Error("DB_NAME must be set (letters, digits, _).");
  if (reset && process.env.NODE_ENV === "production") throw new Error("Refusing to --reset in production.");

  const ssl = String(process.env.DB_SSL ?? "true").toLowerCase() === "false" ? undefined : { rejectUnauthorized: true };
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
    ssl,
  });

  try {
    if (reset) await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
    const [[exists]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ?", [name]);
    if (exists.n && !reset) {
      log(`Database ${name} already exists; nothing applied (use --reset to rebuild).`);
      return;
    }
    await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${name}\``);

    for (const file of [path.join(ROOT, "db", "schema.sql"), ...migrationFiles()]) {
      await conn.query(fs.readFileSync(file, "utf8"));
      log(`applied ${path.relative(ROOT, file)}`);
    }
  } finally {
    await conn.end();
  }
}

module.exports = { setupDatabase, migrationFiles };

if (require.main === module) {
  setupDatabase({ reset: process.argv.includes("--reset") }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
