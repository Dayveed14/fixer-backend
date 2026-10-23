// Route tests trust the signed token as-is (no DB lookup), so their
// queued db.query results aren't consumed by the session check. The
// real session checks are covered in tests/security/sessions.test.js
// and the integration tests.
module.exports = {
  getSessionState: jest.fn(async () => ({})),
  invalidateSession: jest.fn(),
  clearSessionCache: jest.fn(),
};
