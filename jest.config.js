module.exports = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/helpers/env.js"],
  testMatch: ["<rootDir>/tests/**/*.test.js"],
  // Real-database tests run separately: npm run test:integration
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/tests/integration/"],
  verbose: true,
};
