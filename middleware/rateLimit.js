const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

// Limits can be tuned per environment without a code change. Tests set
// these high so ordinary suites never trip them, and the dedicated
// rate-limit tests set them low.
const envInt = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const FIFTEEN_MINUTES = 15 * 60 * 1000;

// Logged-in callers are limited per account (so a shared office/campus
// IP doesn't punish everyone behind it); guests per IP.
const userOrIpKey = (req) =>
  req.user?.id ? `user:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`;

// Contact form: no payment gate, easiest target for spam/abuse bots.
// 5 messages per 15 minutes per IP is generous for a real person, tight for a bot.
const contactLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: envInt("CONTACT_RATE_LIMIT", 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many messages sent. Please try again in a little while.",
  },
});

// Bookings/shipments/payment initialisation. Each call can hit Paystack's
// verify endpoint, so this also protects our Paystack quota.
const paymentFlowLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: envInt("PAYMENT_RATE_LIMIT", 20),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: {
    message: "Too many requests. Please try again in a little while.",
  },
});

// Login: brute-force protection. 10 attempts per 15 minutes per IP is
// enough for someone who mistypes their password a few times, tight for
// a script trying to guess one.
const loginLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: envInt("LOGIN_RATE_LIMIT", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many login attempts. Please try again in a little while.",
  },
});

// Registration: stops scripted account creation.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: envInt("REGISTER_RATE_LIMIT", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many sign-up attempts. Please try again later.",
  },
});

// FixBot: every request writes a row and may cost an AI call. Guests get
// a tighter allowance than signed-in customers.
const diagnosisLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: (req) =>
    req.user?.id
      ? envInt("DIAGNOSIS_RATE_LIMIT_USER", 20)
      : envInt("DIAGNOSIS_RATE_LIMIT_GUEST", 8),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message:
      "You've run a lot of diagnoses in a short time. Please wait a few minutes and try again.",
  },
});

module.exports = {
  contactLimiter,
  paymentFlowLimiter,
  loginLimiter,
  registerLimiter,
  diagnosisLimiter,
};
