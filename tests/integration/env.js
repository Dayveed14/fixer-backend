// Integration test environment. Override any of these from the shell
// (CI sets DB_HOST/DB_USER/DB_PASSWORD for its MySQL service).
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "integration-jwt-secret-at-least-32-chars";
process.env.RESEND_API_KEY ??= "test-resend-key";
process.env.CLOUDINARY_CLOUD_NAME ??= "test-cloud";
process.env.CLOUDINARY_API_KEY ??= "test-key";
process.env.CLOUDINARY_API_SECRET ??= "test-secret";
process.env.PAYSTACK_SECRET_KEY ??= "sk_test_integration";
process.env.DB_HOST ??= "127.0.0.1";
process.env.DB_PORT ??= "3306";
process.env.DB_USER ??= "fixer";
process.env.DB_PASSWORD ??= "fixer";
process.env.DB_NAME ??= "fixer_integration";
process.env.DB_SSL ??= "false";
process.env.DB_POOL_SIZE ??= "20";
process.env.ADMIN_EMAIL ??= "ops@example.com";
process.env.CONTACT_EMAIL_TO ??= "support@example.com";
process.env.GEMINI_API_KEY ??= "test-gemini-key";
process.env.DOTENV_CONFIG_QUIET = "true";
for (const key of [
  "LOGIN_RATE_LIMIT",
  "REGISTER_RATE_LIMIT",
  "PAYMENT_RATE_LIMIT",
  "PASSWORD_RATE_LIMIT",
  "CONTACT_RATE_LIMIT",
  "DIAGNOSIS_RATE_LIMIT_GUEST",
  "DIAGNOSIS_RATE_LIMIT_USER",
]) {
  process.env[key] ??= "100000";
}
