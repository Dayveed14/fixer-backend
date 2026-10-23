// Integration tests: the real app against a real MySQL/MariaDB database
// (no mocked db). Only external services (Paystack, email, Cloudinary,
// AI, MeshCentral) are mocked. Needs a database server — see README.
module.exports = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/integration/env.js"],
  globalSetup: "<rootDir>/tests/integration/globalSetup.js",
  testMatch: ["<rootDir>/tests/integration/**/*.int.test.js"],
  testTimeout: 30000,
  verbose: true,
};
