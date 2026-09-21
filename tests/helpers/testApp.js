// Import this FIRST in every route test file, before requiring supertest
// or the app — jest.mock calls here are hoisted by Babel/Jest to the top
// of this module's own execution, which is enough because Node's require
// cache means app.js (and everything it pulls in) only actually loads the
// first time some test file requires it.
jest.mock("../../config/db");
jest.mock("../../services/mailService");
jest.mock("../../services/notificationService");
jest.mock("../../services/meshCentralService");
jest.mock("../../services/paystackService");
jest.mock("../../services/gemini");

const jwt = require("jsonwebtoken");
const db = require("../../config/db");

/**
 * Signs a token exactly the way User.Controller.js does at login, so
 * verifyToken/authorize in middleware/auth.js accept it the same way
 * they'd accept a real one.
 */
function tokenFor({ id = 1, email = "test@example.com", role = "user" } = {}) {
  return jwt.sign({ id, email, role }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });
}

function authHeader(opts) {
  return `Bearer ${tokenFor(opts)}`;
}

// app.js requires ./config/db at import time (for the startup connectivity
// check) and mounts every route — requiring it here, after the jest.mock
// calls above, is what makes every controller see the mocked db/services.
const app = require("../../app");

module.exports = { app, db, tokenFor, authHeader };
