const express = require("express");
const db = require("../config/db");
const monitor = require("../services/monitor");
const { verifyToken, authorize } = require("../middleware/auth");

const router = express.Router();

const DB_TIMEOUT_MS = 3000;

// GET /api/health — liveness: the process is up. Cheap; no DB call, so
// Render's health check doesn't hammer MySQL.
router.get("/", (req, res) => {
  res.json({ status: "ok", uptime: Math.round(process.uptime()) });
});

// GET /api/health/ready — readiness: can we actually serve requests?
// Checks the database with a timeout so a hung connection reports as
// down rather than hanging the probe.
router.get("/ready", async (req, res) => {
  const started = Date.now();
  let timer;

  try {
    await Promise.race([
      db.query("SELECT 1"),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Database check timed out")),
          DB_TIMEOUT_MS,
        );
      }),
    ]);

    return res.json({
      status: "ok",
      database: "up",
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    console.error("Readiness check failed:", err.message);
    return res.status(503).json({
      status: "unavailable",
      database: "down",
    });
  } finally {
    clearTimeout(timer);
  }
});

// GET /api/health/metrics — admin: error counts, recent alerts, and a
// fresh payment-health check.
router.get("/metrics", verifyToken, authorize("admin"), async (req, res) => {
  const payments = await monitor.checkPaymentHealth();
  res.json({ ...monitor.snapshot(), payments });
});

module.exports = router;
