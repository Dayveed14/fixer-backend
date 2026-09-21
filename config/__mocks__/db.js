// Manual mock for config/db.js. Every controller calls either
// `db.query(sql, params)` (returns a Promise resolving to `[rows]`,
// matching mysql2's promise pool) or, for the one transactional flow in
// Booking.Controller, `await db.getConnection()` followed by
// connection.query/beginTransaction/commit/rollback/release.
//
// Default behaviour: every query resolves to an empty result set. Tests
// override this per-call with `db.query.mockResolvedValueOnce([[...]])`
// or similar. Call `db.__reset()` (or just jest.clearAllMocks() — same
// effect) between tests so leftover mockResolvedValueOnce calls from one
// test don't leak into the next.

const mockConnection = {
  query: jest.fn().mockResolvedValue([[]]),
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commit: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
  release: jest.fn(),
};

const db = {
  query: jest.fn().mockResolvedValue([[]]),
  getConnection: jest.fn((cb) => {
    if (typeof cb === "function") {
      cb(null, mockConnection);
      return;
    }
    return Promise.resolve(mockConnection);
  }),
  mockConnection,
  __reset() {
    db.query.mockReset().mockResolvedValue([[]]);
    db.getConnection.mockClear();
    mockConnection.query.mockReset().mockResolvedValue([[]]);
    mockConnection.beginTransaction.mockReset().mockResolvedValue(undefined);
    mockConnection.commit.mockReset().mockResolvedValue(undefined);
    mockConnection.rollback.mockReset().mockResolvedValue(undefined);
    mockConnection.release.mockReset();
  },
};

module.exports = db;
