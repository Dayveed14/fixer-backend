/* ===========================
   MONITORING & ALERTS
   - Every alert is logged as one JSON line (searchable in Render logs:
     filter on "fixer_alert").
   - If ALERT_WEBHOOK_URL is set, it's also posted there. The body is
     {"text": "..."} which Slack, Discord (append /slack to the webhook
     URL) and most chat tools accept.
   - Critical alerts are emailed to ADMIN_EMAIL.
   - The same alert is sent at most once per ALERT_COOLDOWN_MINUTES
     (default 30), so an outage doesn't flood anyone's inbox.

   What raises an alert:
   - Payment problems: an amount/currency mismatch, a paid payment that
     couldn't be applied, and (from the scheduled check) paid payments
     still unused after 15 minutes or a burst of failed payments.
   - API errors: more than ALERT_5XX_THRESHOLD (default 10) server
     errors within 5 minutes.
=========================== */

const db = require("../config/db");
const sendMail = require("./mailService");
const escapeHtml = require("../utils/escapeHtml");

const minutes = (n) => n * 60 * 1000;
const envNumber = (key, fallback) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const ERROR_WINDOW_MS = minutes(5);
const startedAt = Date.now();

const state = {
  lastSent: new Map(), // alert key → time last sent
  errors: [], // timestamps of recent 5xx responses
  totals: { requests: 0, server_errors: 0, alerts: 0 },
  errorsByRoute: new Map(),
  recentAlerts: [],
};

function log(level, event, detail) {
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...detail });
  if (level === "error") console.error(line);
  else console.warn(line);
}

async function postWebhook(text) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error("Alert webhook failed:", err.message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Raises an alert. Never throws (monitoring must not break the request
 * that triggered it). Returns true if it was sent, false if throttled.
 */
async function alert(key, title, detail = {}, { severity = "critical" } = {}) {
  try {
    const now = Date.now();
    const cooldown = minutes(envNumber("ALERT_COOLDOWN_MINUTES", 30));
    const last = state.lastSent.get(key);
    if (last && now - last < cooldown) return false;
    state.lastSent.set(key, now);

    state.totals.alerts += 1;
    state.recentAlerts.unshift({ key, title, severity, detail, at: new Date(now).toISOString() });
    state.recentAlerts.length = Math.min(state.recentAlerts.length, 20);

    log("error", "fixer_alert", { key, title, severity, detail });

    const lines = Object.entries(detail).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
    const env = process.env.NODE_ENV || "development";

    await postWebhook(`[Fixer ${env}] ${severity.toUpperCase()}: ${title}\n${lines.join("\n")}`);

    if (severity === "critical" && process.env.ADMIN_EMAIL) {
      try {
        await sendMail(
          {
            to: process.env.ADMIN_EMAIL,
            subject: `[Fixer alert] ${title}`,
            html: `<p><strong>${escapeHtml(title)}</strong></p>
                   <pre style="font-family:monospace">${escapeHtml(lines.join("\n"))}</pre>
                   <p>Environment: ${escapeHtml(env)}</p>`,
          },
          "admin",
        );
      } catch (err) {
        console.error("Alert email failed:", err.message);
      }
    }
    return true;
  } catch (err) {
    console.error("Alert failed:", err.message);
    return false;
  }
}

/* ---------------- API errors ---------------- */

/** Express middleware: counts responses and alerts on a burst of 5xx. */
function requestMonitor(req, res, next) {
  res.on("finish", () => {
    state.totals.requests += 1;
    if (res.statusCode < 500) return;

    // 503s from the health probe are expected while the DB is down; they
    // still count, because that's exactly when someone should know.
    const route = `${req.method} ${req.baseUrl || ""}${req.route?.path || req.path}`;
    const now = Date.now();
    state.totals.server_errors += 1;
    state.errorsByRoute.set(route, (state.errorsByRoute.get(route) || 0) + 1);
    state.errors.push(now);
    while (state.errors.length && now - state.errors[0] > ERROR_WINDOW_MS) state.errors.shift();

    log("error", "api_error", { route, status: res.statusCode });

    const threshold = envNumber("ALERT_5XX_THRESHOLD", 10);
    if (state.errors.length >= threshold) {
      alert("api_5xx_burst", `${state.errors.length} server errors in the last 5 minutes`, {
        latest_route: route,
        latest_status: res.statusCode,
      });
    }
  });
  next();
}

/* ---------------- Payments ---------------- */

/** Called by the payment code when something needs a human. */
function paymentAlert(kind, detail) {
  const titles = {
    mismatch: "Payment amount/currency mismatch",
    unapplied: "A customer paid but the payment couldn't be applied",
    unfulfilled: "Paid payments not yet used",
    failures: "Unusual number of failed payments",
  };
  return alert(`payment_${kind}_${detail.reference || "batch"}`, titles[kind] || `Payment: ${kind}`, detail);
}

/**
 * Looks for payment problems the request path can't see on its own.
 * Safe to run from several instances (read-only).
 */
async function checkPaymentHealth() {
  const findings = {};
  try {
    const [unfulfilled] = await db.query(
      `SELECT reference, purpose, amount_kobo, user_id, paid_at
         FROM payment_transactions
        WHERE status = 'success' AND entity_id IS NULL
          AND COALESCE(paid_at, updated_at) < NOW() - INTERVAL 15 MINUTE
          AND COALESCE(paid_at, updated_at) > NOW() - INTERVAL 7 DAY
        ORDER BY paid_at ASC
        LIMIT 20`,
    );
    findings.unfulfilled = unfulfilled.length;
    if (unfulfilled.length) {
      await alert(
        "payment_unfulfilled",
        `${unfulfilled.length} paid payment(s) haven't created a booking/shipment after 15 minutes`,
        {
          references: unfulfilled.map((p) => `${p.reference} (${p.purpose}, ₦${Number(p.amount_kobo) / 100})`).join(", "),
          action: "Admin → Payments → filter 'paid, unused' and follow up or refund.",
        },
      );
    }

    const [[failures]] = await db.query(
      `SELECT COUNT(*) AS count FROM payment_transactions
        WHERE status IN ('failed', 'mismatch')
          AND updated_at > NOW() - INTERVAL 1 HOUR`,
    );
    findings.failed_last_hour = Number(failures.count);
    const threshold = envNumber("ALERT_PAYMENT_FAILURE_THRESHOLD", 5);
    if (findings.failed_last_hour >= threshold) {
      await alert("payment_failures", `${findings.failed_last_hour} failed/mismatched payments in the last hour`, {
        hint: "Check the Paystack dashboard for an outage or a pricing problem.",
      });
    }
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return findings;
    console.error("Payment health check failed:", err.message);
    findings.error = err.message;
  }
  return findings;
}

let timer = null;
function startPaymentHealthJob(intervalMs = minutes(10)) {
  if (timer) return timer;
  timer = setInterval(() => checkPaymentHealth(), intervalMs);
  timer.unref?.();
  return timer;
}

/* ---------------- Snapshot for the admin metrics endpoint ---------------- */

function snapshot() {
  const now = Date.now();
  return {
    uptime_seconds: Math.round((now - startedAt) / 1000),
    requests: state.totals.requests,
    server_errors: state.totals.server_errors,
    server_errors_last_5_min: state.errors.filter((t) => now - t <= ERROR_WINDOW_MS).length,
    errors_by_route: Object.fromEntries([...state.errorsByRoute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
    alerts_sent: state.totals.alerts,
    recent_alerts: state.recentAlerts,
    alert_channels: {
      log: true,
      webhook: Boolean(process.env.ALERT_WEBHOOK_URL),
      email: Boolean(process.env.ADMIN_EMAIL),
    },
  };
}

function resetMonitor() {
  state.lastSent.clear();
  state.errors.length = 0;
  state.errorsByRoute.clear();
  state.recentAlerts.length = 0;
  state.totals = { requests: 0, server_errors: 0, alerts: 0 };
}

module.exports = {
  alert,
  paymentAlert,
  requestMonitor,
  checkPaymentHealth,
  startPaymentHealthJob,
  snapshot,
  resetMonitor,
};
