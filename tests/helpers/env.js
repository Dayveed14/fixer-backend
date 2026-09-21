// Runs before the test framework is installed and before any test file is
// required, so every module that reads these at import time (jwt secret,
// Resend/Cloudinary clients that throw if their key is missing, etc.) sees
// a value. None of these are real credentials — every service that would
// use them is mocked in tests/helpers/mockServices.js.
process.env.JWT_SECRET = "test-jwt-secret";
process.env.RESEND_API_KEY = "test-resend-key";
process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
process.env.CLOUDINARY_API_KEY = "test-key";
process.env.CLOUDINARY_API_SECRET = "test-secret";
process.env.PAYSTACK_SECRET_KEY = "test-paystack-key";
process.env.DB_HOST = "localhost";
process.env.DB_USER = "test";
process.env.DB_PASSWORD = "test";
process.env.DB_NAME = "test";
process.env.DB_PORT = "3306";
