const rateLimit = require("express-rate-limit");

// Contact form: no payment gate, easiest target for spam/abuse bots.
// 5 messages per 15 minutes per IP is generous for a real person, tight for a bot.
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many messages sent. Please try again in a little while.",
  },
});

// Bookings/shipments require a verified Paystack payment to succeed, so spam
// is naturally more expensive — but still worth capping to stop someone from
// hammering the endpoint (and by extension your Paystack verify calls) with
// junk/invalid references.
const paymentFlowLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many requests. Please try again in a little while.",
  },
});

// Login: brute-force protection. 10 attempts per 15 minutes per IP is
// enough for someone who mistypes their password a few times, tight for
// a script trying to guess one.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many login attempts. Please try again in a little while.",
  },
});

module.exports = { contactLimiter, paymentFlowLimiter, loginLimiter };
