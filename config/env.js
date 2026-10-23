// /* ===========================
//    ENVIRONMENT VALIDATION
//    Called once at startup. In production a missing required variable
//    stops the server immediately with a clear message, instead of the
//    app booting and then failing on the first login or payment.
// =========================== */

// const REQUIRED = [
//   "JWT_SECRET",
//   "DB_HOST",
//   "DB_USER",
//   "DB_PASSWORD",
//   "DB_NAME",
//   "PAYSTACK_SECRET_KEY",
//   // services/mailService.js constructs the Resend client at import time
//   // and throws without a key, so the app can't boot without it.
//   "RESEND_API_KEY",
// ];

// // Features degrade (rather than break) without these, so they only warn.
// const RECOMMENDED = [
//   "GEMINI_API_KEY",
//   "CLOUDINARY_CLOUD_NAME",
//   "CLOUDINARY_API_KEY",
//   "CLOUDINARY_API_SECRET",
//   "ADMIN_EMAIL",
// ];

// function validateEnv(env = process.env) {
//   const missing = REQUIRED.filter((key) => !env[key] || !String(env[key]).trim());
//   const missingRecommended = RECOMMENDED.filter((key) => !env[key]);
//   const problems = [];

//   if (env.JWT_SECRET && env.JWT_SECRET.length < 32 && env.NODE_ENV === "production") {
//     problems.push("JWT_SECRET should be at least 32 characters in production.");
//   }

//   if (
//     env.NODE_ENV === "production" &&
//     env.PAYSTACK_SECRET_KEY &&
//     env.PAYSTACK_SECRET_KEY.startsWith("sk_test_")
//   ) {
//     problems.push("PAYSTACK_SECRET_KEY is a TEST key while NODE_ENV=production.");
//   }

//   return {
//     ok: missing.length === 0 && problems.length === 0,
//     missing,
//     missingRecommended,
//     problems,
//   };
// }

// function assertEnv(env = process.env, logger = console) {
//   const result = validateEnv(env);

//   if (result.missingRecommended.length) {
//     logger.warn(
//       `Optional env vars not set (some features disabled): ${result.missingRecommended.join(", ")}`,
//     );
//   }

//   if (!result.ok) {
//     const message = [
//       result.missing.length ? `Missing required env vars: ${result.missing.join(", ")}` : null,
//       ...result.problems,
//     ]
//       .filter(Boolean)
//       .join(" | ");

//     if (env.NODE_ENV === "production") {
//       throw new Error(message);
//     }
//     logger.warn(message);
//   }

//   return result;
// }

// module.exports = { validateEnv, assertEnv, REQUIRED, RECOMMENDED };


/* ===========================
   ENVIRONMENT VALIDATION
   Called once at startup.

   The application can run in production while using Paystack
   test credentials during development/testing.

   IMPORTANT:
   Payment verification must still prevent unverified transactions
   from crediting customer balances.
=========================== */

const REQUIRED = [
  "JWT_SECRET",
  "DB_HOST",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "PAYSTACK_SECRET_KEY",
  "RESEND_API_KEY",
];

const RECOMMENDED = [
  "GEMINI_API_KEY",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "ADMIN_EMAIL",
  "CONTACT_EMAIL_TO",
];

function validateEnv(env = process.env) {
  const missing = REQUIRED.filter(
    (key) => !env[key] || !String(env[key]).trim(),
  );

  const missingRecommended = RECOMMENDED.filter((key) => !env[key]);

  const problems = [];

  if (
    env.JWT_SECRET &&
    env.JWT_SECRET.length < 32 &&
    env.NODE_ENV === "production"
  ) {
    problems.push(
      "JWT_SECRET should be at least 32 characters in production.",
    );
  }

  const paystackKey = env.PAYSTACK_SECRET_KEY || "";

  if (
    paystackKey &&
    !paystackKey.startsWith("sk_test_") &&
    !paystackKey.startsWith("sk_live_")
  ) {
    problems.push(
      "PAYSTACK_SECRET_KEY must be a valid-format Paystack secret key.",
    );
  }

  if (
    env.NODE_ENV === "production" &&
    paystackKey.startsWith("sk_test_")
  ) {
    console.warn(
      "PAYSTACK TEST MODE: The application is running in production " +
        "with Paystack test credentials. Do not use real customer funds.",
    );
  }

  if (env.NODE_ENV === "production" && String(env.DB_SSL).toLowerCase() === "false") {
    console.warn("DB_SSL=false in production: the database connection is not encrypted.");
  }

  return {
    ok: missing.length === 0 && problems.length === 0,
    missing,
    missingRecommended,
    problems,
  };
}

function assertEnv(env = process.env, logger = console) {
  const result = validateEnv(env);

  if (result.missingRecommended.length) {
    logger.warn(
      `Optional env vars not set (some features disabled): ${result.missingRecommended.join(", ")}`,
    );
  }

  if (!result.ok) {
    const message = [
      result.missing.length
        ? `Missing required env vars: ${result.missing.join(", ")}`
        : null,
      ...result.problems,
    ]
      .filter(Boolean)
      .join(" | ");

    if (env.NODE_ENV === "production") {
      throw new Error(message);
    }

    logger.warn(message);
  }

  return result;
}

module.exports = { validateEnv, assertEnv, REQUIRED, RECOMMENDED };
