const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
require("dotenv").config();

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

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

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

db.getConnection((err, connection) => {
  if (err) {
    console.log("Database Connection Failed");
    console.log(err);
  } else {
    console.log("MySQL Connected Successfully");
    connection.release();
  }
});

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

/* Server */

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server Running on Port ${PORT}`);
  });
}

module.exports = app;
