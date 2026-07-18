const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const userApi = require("./routes/User.route");
const ticketApi = require("./routes/Ticket.route");
// const shipmentApi = require("./routes/Shipment.route");
const diagnosisApi = require("./routes/Diagnosis.route");
// const resourceApi = require("./routes/Resource.route");
// const faqApi = require("./routes/FAQ.route");
const articleApi = require("./routes/Article.route");
const statsApi = require("./routes/Stats.route");
const bookingApi = require("./routes/Booking.route");
const ratingApi = require("./routes/Rating.route");
const deviceApi = require("./routes/Device.route");

const db = require("./config/db");

const app = express();

const PORT = process.env.PORT || 4000;

/* Middleware */

const allowedOrigins = [
  "http://localhost:5173",
  "https://fixer-vite.vercel.app",
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
app.use("/api/stats", statsApi);

app.use("/api/tickets", ticketApi);
app.use("/api/bookings", bookingApi);
app.use("/api/ratings", ratingApi);
app.use("/api/devices", deviceApi);

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

app.listen(PORT, () => {
  console.log(`Server Running on Port ${PORT}`);
});
