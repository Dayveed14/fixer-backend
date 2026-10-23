// Builds a fresh database from db/schema.sql + migrations once per run.
module.exports = async () => {
  require("./env");
  const { setupDatabase } = require("../../scripts/db-setup");
  await setupDatabase({ reset: true, log: () => {} });
};
