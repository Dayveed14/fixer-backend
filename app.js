const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
require("dotenv").config();

// Fail fast (in production) on missing configuration.
require("./config/env").assertEnv();

const { COOKIE_NAME } = require("./config/cookie");

const userApi = require("./routes/User.route");
const testApi = require("./routes/Test.route");
const ticketApi = require("./routes/Ticket.route");
// const shipmentApi = require("./routes/Shipment.route");
const diagnosisApi = require("./routes/Diagnosis.route");
// const resourceApi = require("./routes/Resource.route");
// const faqApi = require("./routes/FAQ.route");
const articleApi = require("./routes/Article.route");
const diyVideoApi = require("./routes/DiyVideo.route");
const contactApi = require("./routes/Contact.route");
const shipmentApi = require("./routes/Shipment.route");
const statsApi = require("./routes/Stats.route");
const bookingApi = require("./routes/Booking.route");
const ratingApi = require("./routes/Rating.route");
const deviceApi = require("./routes/Device.route");
const notificationApi = require("./routes/Notification.route");
const paymentApi = require("./routes/Payment.route");
const healthApi = require("./routes/Health.route");
const pricingApi = require("./routes/Pricing.route");

const db = require("./config/db");

const app = express();

// Required for accurate per-IP rate limiting behind Render's reverse proxy —
// without this, express-rate-limit either can't tell clients apart or
// refuses to start (it validates this on purpose, since trusting
// X-Forwarded-For blindly is spoofable if you're not actually behind a proxy).
app.set("trust proxy", 1);

const PORT = process.env.PORT || 4000;

/* Middleware */

const allowedOrigins = [
  "http://localhost:5173",
  "https://fixer-vite.vercel.app",
  "https://fixerng.app",
  "https://www.fixerng.app",
  "https://localhost",
];

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests with no origin (e.g. Postman, server-to-server)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

// Body size limits: nothing in this API legitimately sends large JSON
// (file uploads go through multer, not here). rawBody is kept so the
// Paystack webhook can verify its HMAC signature over the exact bytes.
app.use(
  express.json({
    limit: process.env.JSON_BODY_LIMIT || "100kb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: true, limit: "100kb" }));

app.use(cookieParser());

// CSRF guard: moving auth from a Bearer header (which a malicious page
// can't attach on your behalf) to a cookie (which the browser attaches
// automatically, even cross-site, since it has to be SameSite=None for
// the frontend/backend's different domains) reopens CSRF. This closes
// it cheaply: the real frontend sends a custom header on every
// state-changing request; a plain cross-site form post can't add custom
// headers at all, and a cross-site fetch/XHR trying to add one triggers
// a CORS preflight that the origin allowlist above already blocks. Only
// enforced when a session cookie is actually present — Bearer-token
// clients (mobile apps, Postman, the test suite) aren't affected.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

app.use((req, res, next) => {
  const hasSessionCookie = Boolean(req.cookies?.[COOKIE_NAME]);

  if (
    MUTATING_METHODS.has(req.method) &&
    hasSessionCookie &&
    req.headers["x-fixer-client"] !== "web"
  ) {
    return res.status(403).json({
      message: "Request blocked.",
    });
  }

  return next();
});

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* Test Database Connection */

if (require.main === module) {
  db.query("SELECT 1")
    .then(() => console.log("MySQL Connected Successfully"))
    .catch((err) => {
      console.error("Database Connection Failed");
      console.error(err);
    });
}

/* Routes */

app.use("/api/users", userApi);
app.use("/api/articles", articleApi);
app.use("/api/diy-videos", diyVideoApi);
app.use("/api/contact", contactApi);
app.use("/api/shipments", shipmentApi);
app.use("/api/stats", statsApi);

app.use("/api/tickets", ticketApi);
app.use("/api/bookings", bookingApi);
app.use("/api/ratings", ratingApi);
app.use("/api/devices", deviceApi);
app.use("/api/notifications", notificationApi);
app.use("/api/test", testApi);
app.use("/api/payments", paymentApi);
app.use("/api/health", healthApi);
app.use("/api/pricing", pricingApi);

// app.use("/api/shipments", shipmentApi);

app.use("/api/diagnosis", diagnosisApi);

// app.use("/api/resources", resourceApi);

// app.use("/api/faq", faqApi);

/* Default Route */

app.get("/", (req, res) => {
  res.json({
    message: "SupportHub API Running...",
  });
});

/* Not found + error handling */

app.use("/api", (req, res) => {
  res.status(404).json({ message: "Not found." });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ message: "Request body is too large." });
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Malformed JSON in request body." });
  }

  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({ message: "Origin not allowed." });
  }

  console.error(err);
  return res.status(500).json({ message: "Internal Server Error" });
});

/* Server */

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server Running on Port ${PORT}`);
  });

  // Confirms deliveries the customer didn't confirm in time. Runs at
  // startup (so it catches up after Render wakes the service) and every
  // 5 minutes while running.
  require("./services/shipmentLifecycle").startAutoConfirmJob();
}

module.exports = app;
